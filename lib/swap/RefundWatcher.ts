import InstrumentedLock from '../InstrumentedLock';
import type Logger from '../Logger';
import { formatError } from '../Utils';
import { CurrencyType, swapTypeToPrettyString } from '../consts/Enums';
import TypedEventEmitter from '../consts/TypedEventEmitter';
import type RefundTransaction from '../db/models/RefundTransaction';
import type ReverseSwap from '../db/models/ReverseSwap';
import type { ChainSwapInfo } from '../db/repositories/ChainSwapRepository';
import RefundTransactionRepository from '../db/repositories/RefundTransactionRepository';
import type Sidecar from '../sidecar/Sidecar';
import type { Currency } from '../wallet/WalletManager';

class RefundWatcher extends TypedEventEmitter<{
  'refund.confirmed': {
    swap: ReverseSwap | ChainSwapInfo;
    refundTransaction: string;
  };
}> {
  private static readonly defaultRequiredConfirmations = 1;
  // A refund still unconfirmed this many blocks after the swap's timeout is
  // logged as an error (the alert monitor reports it). For a reverse swap
  // lnd cancels the hold invoice at the earliest about 42 blocks after it,
  // and the payer could then claim the lockup with the preimage.
  public static readonly lateRefundBlocks = 20;
  private static readonly pendingTransactionsLock = 'pendingTransactions';

  private readonly lock = new InstrumentedLock('refundWatcher');
  private currencies!: Map<string, Currency>;

  constructor(
    private readonly logger: Logger,
    private readonly sidecar: Sidecar,
  ) {
    super();
  }

  public init = (currencies: Map<string, Currency>) => {
    this.currencies = currencies;

    this.sidecar.on('block', this.checkPendingTransactions);

    for (const { provider } of this.currencies.values()) {
      if (provider) {
        provider.onBlock(this.checkPendingTransactions);
      }
    }
  };

  private checkPendingTransactions = async () => {
    await this.lock.acquire(
      RefundWatcher.pendingTransactionsLock,
      'checkPendingTransactions',
      async () => {
        const txs = await RefundTransactionRepository.getPendingTransactions();

        for (const { tx, swap } of txs) {
          await this.checkTransaction(tx, swap);
        }
      },
    );
  };

  public checkTransaction = async (
    tx: RefundTransaction,
    swap: ReverseSwap | ChainSwapInfo,
  ) => {
    try {
      await this.checkRefund(tx, swap);
    } catch (error) {
      this.logger.error(
        `Error checking refund transaction of ${swapTypeToPrettyString(swap.type)} ${swap.id}: ${formatError(error)}`,
      );
    }
  };

  private checkRefund = async (
    tx: RefundTransaction,
    swap: ReverseSwap | ChainSwapInfo,
  ) => {
    const refundCurrency = this.currencies.get(swap.refundCurrency);
    if (refundCurrency === undefined) {
      throw new Error(`unknown refund currency: ${swap.refundCurrency}`);
    }

    const requiredConfirmations = this.getRequiredConfirmations(refundCurrency);
    const confirmations = await this.getUtxoConfirmations(
      refundCurrency,
      tx,
      swap,
    );

    if (confirmations < requiredConfirmations) {
      return;
    }

    const confirmed =
      await RefundTransactionRepository.setStatusConfirmedIfPending(swap.id);
    if (!confirmed) {
      return;
    }

    this.logger.debug(
      `Refund transaction of ${swapTypeToPrettyString(swap.type)} swap ${swap.id} confirmed: ${tx.id}`,
    );

    this.emit('refund.confirmed', {
      swap,
      refundTransaction: tx.id,
    });
  };

  /**
   * Confirmations of a refund; for UTXO chains, a refund that left the
   * node's mempool is sent again (from the wallet, which it pays), and one
   * that is late is logged as an error.
   */
  private getUtxoConfirmations = async (
    currency: Currency,
    tx: RefundTransaction,
    swap: ReverseSwap | ChainSwapInfo,
  ): Promise<number> => {
    if (
      currency.type !== CurrencyType.BitcoinLike &&
      currency.type !== CurrencyType.Liquid
    ) {
      return await this.getConfirmations(currency, tx.id);
    }

    const chainClient = currency.chainClient!;
    let confirmations: number;
    try {
      confirmations =
        (await chainClient.getRawTransactionVerbose(tx.id)).confirmations ?? 0;
    } catch (error) {
      await this.sendAgain(currency, tx, swap, error);
      confirmations = 0;
    }

    if (confirmations === 0) {
      const timeout =
        'sendingData' in swap
          ? swap.sendingData.timeoutBlockHeight
          : swap.timeoutBlockHeight;
      const { blocks } = await chainClient.getBlockchainInfo();
      if (blocks - timeout >= RefundWatcher.lateRefundBlocks) {
        this.logger.error(
          `Refund ${tx.id} of ${swapTypeToPrettyString(swap.type)} Swap ${swap.id} is not confirmed ${blocks - timeout} blocks after the swap's timeout`,
        );
      }
    }

    return confirmations;
  };

  private sendAgain = async (
    currency: Currency,
    tx: RefundTransaction,
    swap: ReverseSwap | ChainSwapInfo,
    error: unknown,
  ) => {
    const chainClient = currency.chainClient!;
    this.logger.warn(
      `Refund ${tx.id} of ${swapTypeToPrettyString(swap.type)} Swap ${swap.id} not found (${formatError(error)}); sending it again`,
    );
    try {
      const { hex } = await chainClient.getWalletTransaction(tx.id);
      await chainClient.sendRawTransaction(hex);
    } catch (sendError) {
      this.logger.warn(
        `Could not send refund ${tx.id} of ${swapTypeToPrettyString(swap.type)} Swap ${swap.id} again: ${formatError(sendError)}`,
      );
    }
  };

  private getRequiredConfirmations = (currency: Currency) =>
    currency.requiredConfirmations !== undefined &&
    currency.requiredConfirmations > 0
      ? Math.ceil(currency.requiredConfirmations)
      : RefundWatcher.defaultRequiredConfirmations;

  private getConfirmations = async (currency: Currency, txId: string) => {
    switch (currency.type) {
      case CurrencyType.BitcoinLike:
      case CurrencyType.Liquid: {
        const info = await currency.chainClient!.getRawTransactionVerbose(txId);
        return info.confirmations || 0;
      }
      case CurrencyType.Ether:
      case CurrencyType.ERC20: {
        const receipt = await currency.provider!.getTransactionReceipt(txId);
        if (receipt === null) {
          return 0;
        }

        // TODO: gracefully handle failed txs
        if (receipt.status !== 1) {
          this.logger.warn(
            `${currency.symbol} EVM refund transaction ${txId} failed: ${receipt.status}`,
          );
          return 0;
        }

        return await receipt.confirmations();
      }

      case CurrencyType.Ark: {
        // We always consider Ark transactions as confirmed
        return this.getRequiredConfirmations(currency) + 1;
      }
    }
  };
}

export default RefundWatcher;
