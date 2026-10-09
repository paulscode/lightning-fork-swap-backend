import Logger from '../../../../lib/Logger';
import { SwapType } from '../../../../lib/consts/Enums';
import type Swap from '../../../../lib/db/models/Swap';
import Errors from '../../../../lib/service/Errors';
import DeferredClaimer from '../../../../lib/service/cooperative/DeferredClaimer';

describe('DeferredClaimer.broadcastCooperative', () => {
  const swap = { id: 'sub', type: SwapType.Submarine } as Swap;

  const newClaimer = () =>
    new DeferredClaimer(
      Logger.disabledLogger,
      {} as never,
      new Map(),
      { isBatchOnly: () => false } as never,
      { wallets: new Map() } as never,
      0 as never,
      {
        deferredClaimSymbols: [],
        expiryTolerance: 10,
        batchClaimInterval: '*/15 * * * *',
      } as never,
    );

  test('should sign with one nonce once, even when the broadcast fails', async () => {
    const claimer = newClaimer();
    const toClaim = {
      swap,
      preimage: Buffer.alloc(32),
      cooperative: { musig: {}, transaction: {}, sweepAddress: 'bc1q' },
    };
    claimer['getToClaimDetails'] = jest
      .fn()
      .mockResolvedValue({ toClaim, chainCurrency: { symbol: 'BTC' } });
    const broadcast = jest
      .fn()
      .mockRejectedValue(new Error('min relay fee not met'));
    claimer['broadcastCooperativeTransaction'] = broadcast;

    await expect(
      claimer.broadcastCooperative(swap, Buffer.alloc(66), Buffer.alloc(32)),
    ).rejects.toThrow('min relay fee not met');
    await expect(
      claimer.broadcastCooperative(swap, Buffer.alloc(66, 1), Buffer.alloc(32)),
    ).rejects.toEqual(Errors.NOT_ELIGIBLE_FOR_COOPERATIVE_CLAIM_BROADCAST());

    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
