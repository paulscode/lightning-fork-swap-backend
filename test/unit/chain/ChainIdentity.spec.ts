import Logger from '../../../lib/Logger';
import type { IChainClient } from '../../../lib/chain/ChainClient';
import {
  ChainIdentityError,
  blake2bActivation,
  checkChainIdentity,
} from '../../../lib/chain/ChainIdentity';
import { resolveBitcoinNetwork } from '../../../lib/consts/BitcoinNetworks';

const Networks = {
  bitcoinMainnet: resolveBitcoinNetwork('bitcoin')!,
  bitcoinRegtest: resolveBitcoinNetwork('regtest')!,
};

const client = (blocks: number, hash: string) =>
  ({
    getBlockchainInfo: jest.fn().mockResolvedValue({ blocks }),
    getBlockhash: jest.fn().mockResolvedValue(hash),
  }) as unknown as IChainClient;

describe('ChainIdentity', () => {
  test('should accept a mainnet node on the BLAKE2b chain', async () => {
    const c = client(974615, blake2bActivation.hash);
    await expect(
      checkChainIdentity(
        Logger.disabledLogger,
        'BTC',
        c,
        Networks.bitcoinMainnet,
      ),
    ).resolves.toBeUndefined();
    expect(c.getBlockhash).toHaveBeenCalledWith(blake2bActivation.height);
  });

  test('should refuse a mainnet node on the SHA256 chain', async () => {
    const c = client(
      969087,
      '00000000000000000001d82da6ecccf08e07afa383f9212b0e1b95cc72430c00',
    );
    await expect(
      checkChainIdentity(
        Logger.disabledLogger,
        'BTC',
        c,
        Networks.bitcoinMainnet,
      ),
    ).rejects.toBeInstanceOf(ChainIdentityError);
  });

  test('should refuse a mainnet node below the activation height', async () => {
    const c = client(blake2bActivation.height - 1, '');
    await expect(
      checkChainIdentity(
        Logger.disabledLogger,
        'BTC',
        c,
        Networks.bitcoinMainnet,
      ),
    ).rejects.toBeInstanceOf(ChainIdentityError);
    expect(c.getBlockhash).not.toHaveBeenCalled();
  });

  test('should refuse when the node cannot answer', async () => {
    const c = {
      getBlockchainInfo: jest
        .fn()
        .mockRejectedValue(new Error('connection refused')),
    } as unknown as IChainClient;
    await expect(
      checkChainIdentity(
        Logger.disabledLogger,
        'BTC',
        c,
        Networks.bitcoinMainnet,
      ),
    ).rejects.toThrow('connection refused');
  });

  test('should not check regtest', async () => {
    const c = client(0, '');
    await expect(
      checkChainIdentity(
        Logger.disabledLogger,
        'BTC',
        c,
        Networks.bitcoinRegtest,
      ),
    ).resolves.toBeUndefined();
    expect(c.getBlockchainInfo).not.toHaveBeenCalled();
  });
});
