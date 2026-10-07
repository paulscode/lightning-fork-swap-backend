import type Logger from '../Logger';
import type { BitcoinNetwork } from '../consts/BitcoinNetworks';
import type { IChainClient } from './ChainClient';

/**
 * The Bitcoin BLAKE2b chain shares its genesis block, network name and
 * address format with the SHA256 chain it split from, so a node on either
 * one answers every ordinary query the same way until the fork height. The
 * block at the activation height is where they part: on the BLAKE2b chain it
 * is this one, and on the other chain it is something else.
 */
export const blake2bActivation = {
  height: 961640,
  hash: '0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb',
};

/** How often a running service asks again. */
export const chainIdentityRecheckMs = 10 * 60 * 1000;

export class ChainIdentityError extends Error {}

/**
 * Throws unless the node behind `client` follows the Bitcoin BLAKE2b chain.
 * Only mainnet has a pinned activation block; other networks are accepted
 * with a log line, since their activation height is chosen per test chain.
 * "Cannot tell" is a refusal: an RPC error propagates.
 */
export const checkChainIdentity = async (
  logger: Logger,
  symbol: string,
  client: IChainClient,
  network: BitcoinNetwork,
): Promise<void> => {
  if (network.bech32 !== 'bc') {
    logger.verbose(
      `${symbol} chain identity: not mainnet (${network.bech32}), no pinned activation block to check`,
    );
    return;
  }

  const info = await client.getBlockchainInfo();
  if (info.blocks < blake2bActivation.height) {
    throw new ChainIdentityError(
      `${symbol} node is at height ${info.blocks}, below the BLAKE2b activation at ${blake2bActivation.height}: cannot tell which chain it follows`,
    );
  }

  const hash = await client.getBlockhash(blake2bActivation.height);
  if (hash !== blake2bActivation.hash) {
    throw new ChainIdentityError(
      `${symbol} node follows another chain: block ${blake2bActivation.height} is ${hash}, the Bitcoin BLAKE2b chain has ${blake2bActivation.hash}`,
    );
  }

  logger.verbose(
    `${symbol} chain identity confirmed: block ${blake2bActivation.height} is ${hash}`,
  );
};

/**
 * Feature bits of a Lightning node on the Bitcoin BLAKE2b chain
 * (`option_blake2b`, required or optional). A node without either is on the
 * SHA256 chain, or does not know the BLAKE2b one.
 */
export const blake2bFeatureBits = [512, 513];

/**
 * Throws unless a Lightning node advertises the BLAKE2b feature bit. Like
 * the chain identity check, only on mainnet; a node that reports no features
 * cannot tell, and is refused.
 */
export const checkLightningChainIdentity = (
  logger: Logger,
  service: string,
  features: number[] | undefined,
  network: BitcoinNetwork,
): void => {
  if (network.bech32 !== 'bc') {
    return;
  }

  if (!features?.some((bit) => blake2bFeatureBits.includes(bit))) {
    throw new ChainIdentityError(
      `${service} does not advertise feature bit ${blake2bFeatureBits.join(' or ')}: it is not a Lightning node of the Bitcoin BLAKE2b chain`,
    );
  }

  logger.verbose(`${service} advertises the BLAKE2b feature bit`);
};
