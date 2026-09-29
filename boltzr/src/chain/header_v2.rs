//! Block headers of the Bitcoin BLAKE2b chain.
//!
//! From the hard fork at mainnet height 961640 a block header can be a "v2"
//! header: the classic 80 bytes followed by 84 bytes of new fields, marked by
//! the top bit of the version word. Its block id is not SHA256d of the header
//! but a BLAKE2b construction over the fields. `bitcoin::Block` knows neither,
//! so a raw block carrying such a header has to be split here before the
//! transactions can be decoded, and its id computed here too.
//!
//! The construction mirrors Bitcoin Knots (`pow_hf_blake2b`) and
//! `btcd-blake2b/wire/blake2b.go`. It works on the serialized bytes, so the
//! version word and time are hashed exactly as they appear on the wire.

use blake2::Blake2b;
use blake2::digest::Digest as _;
use blake2::digest::consts::U32;
use sha2::Sha256;

/// Length of a classic header.
pub const HEADER_LEN_V1: usize = 80;

/// Length of a v2 header: the classic 80 bytes and 84 more.
pub const HEADER_LEN_V2: usize = HEADER_LEN_V1 + 84;

/// The version-word bit that marks a v2 header.
pub const HEADER_V2_VERSION_FLAG: u32 = 0x8000_0000;

const TAG_XOR_KEY: &[u8] = b"Bitcoin block hash PoW XOR key";
const TAG_XOR_MASK: &[u8] = b"Bitcoin block hash PoW XOR mask";
const TAG_PREV_HIDDEN: &[u8] = b"Bitcoin prevblock header, hashed";
const TAG_HEADER_1: &[u8] = b"Bitcoin block header 1";
const TAG_MERGE_MINE: &[u8] = b"Merge-mining hook";

// Offsets of the v2 fields, counted from the start of the header.
const OFF_NONCE2: usize = 80;
const OFF_NONCE3: usize = 84;
const OFF_EXTRANONCE: usize = 88;
const OFF_TIME_OFFSET: usize = 104;
const OFF_TX_COUNT: usize = 108;
const OFF_FLAGS: usize = 110;
const OFF_CLEAR_BITS: usize = 111;
const OFF_XOR_KEY: usize = 112;
const OFF_HEIGHT: usize = 128;
const OFF_MMRHS: usize = 132;

/// The length of the header at the start of `bytes`, decided by its version
/// word, or `None` when there are not even four bytes to read it from.
pub fn header_len(bytes: &[u8]) -> Option<usize> {
    let version = u32::from_le_bytes(bytes.get(0..4)?.try_into().ok()?);
    Some(if version & HEADER_V2_VERSION_FLAG != 0 {
        HEADER_LEN_V2
    } else {
        HEADER_LEN_V1
    })
}

fn tagged_hash(tag: &[u8], msgs: &[&[u8]]) -> [u8; 32] {
    let tag_hash = Sha256::digest(tag);
    let mut hasher = Sha256::new();
    hasher.update(tag_hash);
    hasher.update(tag_hash);
    for msg in msgs {
        hasher.update(msg);
    }
    hasher.finalize().into()
}

fn blake2b_256(data: &[u8]) -> [u8; 32] {
    Blake2b::<U32>::digest(data).into()
}

/// The block id of a v2 header, in the byte order it is displayed in (the
/// order `getblockhash` prints, the reverse of the internal order).
pub fn block_hash_v2(header: &[u8; HEADER_LEN_V2]) -> [u8; 32] {
    let version = &header[0..4];
    let prev_block = &header[4..36];
    let merkle_root = &header[36..68];
    let time_on_wire = &header[68..72];
    let bits = &header[72..76];
    let nonce = &header[76..80];
    let nonce2 = &header[OFF_NONCE2..OFF_NONCE2 + 4];
    let nonce3 = &header[OFF_NONCE3..OFF_NONCE3 + 4];
    let extranonce = &header[OFF_EXTRANONCE..OFF_EXTRANONCE + 16];
    let time_offset = &header[OFF_TIME_OFFSET..OFF_TIME_OFFSET + 4];
    let tx_count = u16::from_le_bytes([header[OFF_TX_COUNT], header[OFF_TX_COUNT + 1]]);
    let flags = header[OFF_FLAGS];
    let clear_bits = header[OFF_CLEAR_BITS];
    let xor_key = &header[OFF_XOR_KEY..OFF_XOR_KEY + 16];
    let height = &header[OFF_HEIGHT..OFF_HEIGHT + 4];
    let mmrhs = &header[OFF_MMRHS..OFF_MMRHS + 32];

    let xor_key_hash = tagged_hash(TAG_XOR_KEY, &[xor_key]);

    // The mask is all zero for a zero key; otherwise the tagged hash with
    // its leading `clear_bits` bits cleared.
    let mut mask = [0u8; 32];
    if xor_key.iter().any(|b| *b != 0) {
        mask = tagged_hash(TAG_XOR_MASK, &[xor_key]);
        let clear_bytes = (clear_bits / 8) as usize;
        for byte in mask.iter_mut().take(clear_bytes) {
            *byte = 0;
        }
        if clear_bytes < mask.len() {
            mask[clear_bytes] &= 0xff >> (clear_bits % 8);
        }
    }

    let mut prev_sane = [0u8; 32];
    for (i, byte) in prev_sane.iter_mut().enumerate() {
        *byte = prev_block[31 - i];
    }
    let prev_hidden = tagged_hash(TAG_PREV_HIDDEN, &[&prev_sane]);

    let mut h1 = Vec::with_capacity(119);
    h1.extend_from_slice(version);
    h1.extend_from_slice(&prev_sane);
    h1.extend_from_slice(height);
    h1.extend_from_slice(merkle_root);
    h1.extend_from_slice(time_on_wire);
    h1.push(0); // reserved for an extended 40-bit time
    h1.extend_from_slice(bits);
    h1.extend_from_slice(&u32::from(tx_count).to_le_bytes());
    h1.push(flags);
    h1.push(clear_bits);
    h1.extend_from_slice(&xor_key_hash);
    let h1 = tagged_hash(TAG_HEADER_1, &[&h1]);

    let zeros = [0u8; 32];
    let h2 = tagged_hash(TAG_MERGE_MINE, &[&h1, &zeros, mmrhs]);

    let mut ss = Vec::with_capacity(52);
    ss.extend_from_slice(&[0, 0, 0, 0]);
    ss.extend_from_slice(&h2);
    ss.extend_from_slice(extranonce);
    let root = blake2b_256(&ss);

    // The second pass is laid out the way the mining hardware sees it; the
    // low two flag bits say which of the four layouts that was.
    let mut asic = Vec::with_capacity(144);
    match flags & 3 {
        3 | 2 => {
            if flags & 3 == 3 {
                asic.extend_from_slice(&zeros);
            }
            asic.extend_from_slice(&zeros);
            asic.extend_from_slice(&zeros[..16]);
            asic.extend_from_slice(&h2);
            asic.extend_from_slice(nonce);
            asic.extend_from_slice(nonce2);
            asic.extend_from_slice(time_offset);
            asic.extend_from_slice(nonce3);
            asic.extend_from_slice(&root);
        }
        0 => {
            let mut hidden = prev_hidden;
            for byte in hidden.iter_mut().take(6) {
                *byte = 0;
            }
            asic.extend_from_slice(&hidden);
            asic.extend_from_slice(nonce);
            asic.extend_from_slice(nonce2);
            asic.extend_from_slice(time_offset);
            asic.extend_from_slice(nonce3);
            asic.extend_from_slice(&root);
        }
        _ => {
            asic.extend_from_slice(nonce);
            asic.extend_from_slice(nonce2);
            asic.extend_from_slice(nonce3);
            asic.extend_from_slice(time_offset);
            asic.extend_from_slice(&root);
            asic.extend_from_slice(&h2);
        }
    }
    let hash2 = blake2b_256(&asic);

    let mut hash = [0u8; 32];
    for i in 0..32 {
        hash[i] = hash2[i] ^ mask[i];
    }
    hash
}

#[cfg(test)]
mod test {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vector {
        header: String,
        hash: String,
    }

    fn check(vectors: &str) -> usize {
        let vectors: Vec<Vector> = serde_json::from_str(vectors).unwrap();
        let mut v2 = 0;
        for v in &vectors {
            let raw = hex::decode(&v.header).unwrap();
            assert_eq!(header_len(&raw), Some(raw.len()), "{}", v.hash);
            if raw.len() == HEADER_LEN_V2 {
                let hash = block_hash_v2(&raw.as_slice().try_into().unwrap());
                assert_eq!(hex::encode(hash), v.hash);
                v2 += 1;
            }
        }
        v2
    }

    /// Headers and ids read from a mainnet node, from just before the
    /// activation to the tip at the time of writing.
    #[test]
    fn mainnet_vectors() {
        assert!(check(include_str!("header_v2_mainnet.json")) >= 80);
    }

    /// Random headers hashed by the btcd-blake2b reference, covering all
    /// four ASIC layouts, the time offset flag, XOR keys with cleared mask
    /// bits and a non-zero merge-mining commitment, none of which mainnet
    /// blocks have used yet.
    #[test]
    fn reference_vectors() {
        assert_eq!(check(include_str!("header_v2_reference.json")), 64);
    }

    /// A whole mainnet block with a v2 header, as ZMQ `rawblock` and
    /// `getblock <hash> 0` deliver it.
    #[test]
    fn parse_v2_block() {
        use crate::chain::types::Type;
        use crate::chain::utils::{Block, Transaction};

        let block =
            Block::parse_hex(&Type::Bitcoin, include_str!("block_v2_974606.hex").trim()).unwrap();
        assert_eq!(
            hex::encode(block.block_hash()),
            "0000000000000000d3ed07229ab975e3e531ec0a15f258877ae9af637afc7971"
        );
        let txids: Vec<String> = block
            .transactions
            .iter()
            .map(|tx| match tx {
                Transaction::Bitcoin(tx) => tx.compute_txid().to_string(),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(
            txids,
            vec![
                "d47564add93e8075de29031a808c62457c920f5429c11838b4809384a76b3670",
                "847a35218141f3b0f236ecb8ba53cf4729e69c0996ac021e2cba53b5ee123760",
                "7fc2a0a8c5da9cc26dabe908250d58e7d9f5a69fa9c82e062f487e5bef67739c",
            ]
        );
    }

    /// A v2 version word with the block cut short must be an error, not a
    /// panic or a misread classic block.
    #[test]
    fn parse_truncated_v2_block() {
        use crate::chain::types::Type;
        use crate::chain::utils::Block;

        let hex = include_str!("block_v2_974606.hex").trim();
        assert!(Block::parse_hex(&Type::Bitcoin, &hex[..2 * 150]).is_err());
        assert!(Block::parse_hex(&Type::Bitcoin, &hex[..2 * 170]).is_err());
    }

    #[test]
    fn header_len_by_version() {
        assert_eq!(header_len(&[0x00, 0x00, 0x00, 0x20]), Some(HEADER_LEN_V1));
        assert_eq!(header_len(&[0x00, 0x00, 0x00, 0xa0]), Some(HEADER_LEN_V2));
        assert_eq!(header_len(&[0x00, 0x00]), None);
    }
}
