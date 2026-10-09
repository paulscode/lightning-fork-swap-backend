import EventEmitter from 'events';
import Logger from '../../../lib/Logger';
import { CurrencyType, SwapType } from '../../../lib/consts/Enums';
import type RefundTransaction from '../../../lib/db/models/RefundTransaction';
import type ReverseSwap from '../../../lib/db/models/ReverseSwap';
import RefundTransactionRepository from '../../../lib/db/repositories/RefundTransactionRepository';
import type Sidecar from '../../../lib/sidecar/Sidecar';
import RefundWatcher from '../../../lib/swap/RefundWatcher';
import type { Currency } from '../../../lib/wallet/WalletManager';

describe('RefundWatcher (UTXO refunds)', () => {
  const tx = { id: 'refund', swapId: 'rev' } as RefundTransaction;
  const swap = {
    id: 'rev',
    type: SwapType.ReverseSubmarine,
    refundCurrency: 'BTC',
    timeoutBlockHeight: 1000,
  } as unknown as ReverseSwap;

  const chainClient = {
    getRawTransactionVerbose: jest.fn(),
    getBlockchainInfo: jest.fn(),
    getWalletTransaction: jest.fn(),
    sendRawTransaction: jest.fn(),
  };
  const logger = {
    ...Logger.disabledLogger,
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;

  let watcher: RefundWatcher;

  beforeEach(() => {
    jest.clearAllMocks();
    RefundTransactionRepository.setStatusConfirmedIfPending = jest
      .fn()
      .mockResolvedValue(true);
    chainClient.getBlockchainInfo.mockResolvedValue({ blocks: 1001 });
    chainClient.getWalletTransaction.mockResolvedValue({ hex: 'refundhex' });
    chainClient.sendRawTransaction.mockResolvedValue('refund');
    watcher = new RefundWatcher(logger, new EventEmitter() as Sidecar);
    watcher.init(
      new Map([
        [
          'BTC',
          {
            symbol: 'BTC',
            type: CurrencyType.BitcoinLike,
            chainClient,
            requiredConfirmations: 3,
          } as unknown as Currency,
        ],
      ]),
    );
  });

  test('should confirm a refund that is deep enough', async () => {
    chainClient.getRawTransactionVerbose.mockResolvedValue({
      confirmations: 3,
    });
    const confirmed = jest.fn();
    watcher.on('refund.confirmed', confirmed);

    await watcher.checkTransaction(tx, swap);

    expect(confirmed).toHaveBeenCalledWith({
      swap,
      refundTransaction: 'refund',
    });
    expect(chainClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  test('should send a refund that left the mempool again, from the wallet', async () => {
    chainClient.getRawTransactionVerbose.mockRejectedValue(
      new Error('No such mempool or blockchain transaction'),
    );

    await watcher.checkTransaction(tx, swap);

    expect(chainClient.getWalletTransaction).toHaveBeenCalledWith('refund');
    expect(chainClient.sendRawTransaction).toHaveBeenCalledWith('refundhex');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('should not resend a refund in the mempool', async () => {
    chainClient.getRawTransactionVerbose.mockResolvedValue({});

    await watcher.checkTransaction(tx, swap);

    expect(chainClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each`
    blocks                                       | late
    ${1000 + RefundWatcher.lateRefundBlocks - 1} | ${false}
    ${1000 + RefundWatcher.lateRefundBlocks}     | ${true}
  `(
    'should report an unconfirmed refund at $blocks as late: $late',
    async ({ blocks, late }) => {
      chainClient.getRawTransactionVerbose.mockResolvedValue({
        confirmations: 0,
      });
      chainClient.getBlockchainInfo.mockResolvedValue({ blocks });

      await watcher.checkTransaction(tx, swap);

      if (late) {
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("blocks after the swap's timeout"),
        );
      } else {
        expect(logger.error).not.toHaveBeenCalled();
      }
    },
  );
});
