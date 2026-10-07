import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Logger from '../../../lib/Logger';
import LndClient from '../../../lib/lightning/LndClient';
import { GetInfoResponse } from '../../../lib/proto/lnd/rpc';

describe('LndClient', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lndclient-'));
  const certpath = join(dir, 'tls.cert');
  const macaroonpath = join(dir, 'admin.macaroon');
  writeFileSync(certpath, 'not a certificate; never connected');
  writeFileSync(macaroonpath, Buffer.alloc(32));

  afterAll(() => {
    rmSync(dir, { recursive: true });
  });

  test('should report the feature bits of getinfo', async () => {
    // Through the wire format, as lnd's answer arrives
    const response = GetInfoResponse.decode(
      GetInfoResponse.encode(
        GetInfoResponse.fromPartial({
          version: '0.21.3-beta-blake2b.17',
          identityPubkey: '03cd',
          features: {
            0: { name: 'data-loss-protect', isRequired: true, isKnown: true },
            512: { name: 'blake2b', isRequired: true, isKnown: true },
            515: { name: 'unified-sigs', isRequired: false, isKnown: true },
          },
        }),
      ).finish(),
    );

    const client = new LndClient(
      Logger.disabledLogger,
      'BTC',
      { host: '127.0.0.1', port: 10009, certpath, macaroonpath } as any,
      {} as any,
      undefined as any,
    );
    (client as any).unaryLightningCall = jest.fn().mockResolvedValue(response);

    const info = await client.getInfo();
    expect(info.features?.sort((a, b) => a - b)).toEqual([0, 512, 515]);
    expect(info.version).toEqual('0.21.3-beta-blake2b.17');
  });
});
