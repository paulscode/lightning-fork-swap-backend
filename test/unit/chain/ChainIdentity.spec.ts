import Logger from '../../../lib/Logger';
import type { IChainClient } from '../../../lib/chain/ChainClient';
import {
  ChainIdentityError,
  blake2bActivation,
  checkChainIdentity,
  checkLightningChainIdentity,
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

  describe('checkLightningChainIdentity', () => {
    test.each`
      description             | features
      ${'bit 512 (required)'} | ${[0, 5, 512, 515]}
      ${'bit 513 (optional)'} | ${[513]}
    `('should accept a mainnet node with $description', ({ features }) => {
      expect(() =>
        checkLightningChainIdentity(
          Logger.disabledLogger,
          'BTC LND',
          features,
          Networks.bitcoinMainnet,
        ),
      ).not.toThrow();
    });

    test.each`
      description                 | features
      ${'no BLAKE2b feature bit'} | ${[0, 5, 9, 14, 17]}
      ${'no features'}            | ${[]}
      ${'unreported features'}    | ${undefined}
    `('should refuse a mainnet node with $description', ({ features }) => {
      expect(() =>
        checkLightningChainIdentity(
          Logger.disabledLogger,
          'BTC LND',
          features,
          Networks.bitcoinMainnet,
        ),
      ).toThrow(
        new ChainIdentityError(
          'BTC LND does not advertise feature bit 512 or 513: it is not a Lightning node of the Bitcoin BLAKE2b chain',
        ),
      );
    });

    test('should not check other networks', () => {
      expect(() =>
        checkLightningChainIdentity(
          Logger.disabledLogger,
          'BTC LND',
          [],
          Networks.bitcoinRegtest,
        ),
      ).not.toThrow();
    });
  });
});
