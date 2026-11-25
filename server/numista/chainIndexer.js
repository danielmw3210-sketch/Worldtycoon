import crypto from 'crypto';
import { numistaRpc } from './rpc.js';
import { deedAssetId } from '../data/deedRegistry.js';

const ERAS = [
  { rarity: 'Common', badge: 'common', mult: 1, w: 60, picks: [{ year: 1918, ruler: 'George V' }, { year: 1915, ruler: 'George V' }, { year: 1911, ruler: 'George V (Coronation)' }, { year: 1907, ruler: 'Edward VII' }, { year: 1899, ruler: 'Victoria (Veiled Head)' }] },
  { rarity: 'Uncommon', badge: 'uncommon', mult: 1.5, w: 24, picks: [{ year: 1887, ruler: 'Victoria (Golden Jubilee)' }, { year: 1872, ruler: 'Victoria (Young Head)' }, { year: 1853, ruler: 'Victoria (Young Head)' }] },
  { rarity: 'Rare', badge: 'rare', mult: 3, w: 11, picks: [{ year: 1831, ruler: 'William IV' }, { year: 1826, ruler: 'George IV' }, { year: 1821, ruler: 'George IV (Laureate)' }] },
  { rarity: 'Ultra Rare', badge: 'ultra_rare', mult: 7, w: 4, picks: [{ year: 1817, ruler: 'George III (Bull Head)' }, { year: 1797, ruler: 'George III (Soho Mint)' }, { year: 1787, ruler: 'George III (Spade)' }] },
  { rarity: 'Mythic', badge: 'mythic', mult: 20, w: 1, picks: [{ year: 1703, ruler: 'Queen Anne (VIGO)' }, { year: 1694, ruler: 'William & Mary' }, { year: 1663, ruler: 'Charles II (First Milled)' }] }
];

export function coinAssetId(serial) {
  return crypto.createHash('sha256').update(`numista:coin:${String(serial || '').trim().toUpperCase()}`).digest('hex');
}

export function deriveDeterministicCoinEra(seedHex, index = 0) {
  const h = crypto.createHash('sha256').update(`${seedHex}:${index}`).digest();
  const roll = h.readUInt32BE(0) % 100;
  let acc = 0, era = ERAS;
  for (const e of ERAS) { acc += e.w; if (roll < acc) { era = e; break; } }
  const pk = era.picks[h.readUInt32BE(4) % era.picks.length];
  return { year: pk.year, ruler: pk.ruler, rarity: era.rarity, badge: era.badge, collectorMult: era.mult, proofHash: h.toString('hex').slice(0, 16) };
}

export async function searchBlockchain(rawQuery, gameStore) {
  const q = String(rawQuery || '').trim();
  if (!q) throw new Error('Enter a block height, block hash, tx hash, coin serial, plot ID, @username, or Sb.../UGN... address');

  // 1. Block height (digits)
  if (/^\d+$/.test(q)) {
    const height = Number(q);
    const blk = await numistaRpc._daemonJsonRpc('get_block', { height });
    const hdr = blk.block_header || {};
    const txHashes = blk.tx_hashes || [];
    if (hdr.miner_tx_hash) txHashes.unshift(hdr.miner_tx_hash);
    return {
      kind: 'block',
      height: hdr.height,
      hash: hdr.hash,
      prevHash: hdr.prev_hash,
      timestamp: hdr.timestamp ? new Date(hdr.timestamp * 1000).toISOString() : null,
      difficulty: hdr.difficulty,
      rewardNum: +(Number(hdr.reward || 0) / 1e12).toFixed(4),
      txCount: txHashes.length,
      txHashes
    };
  }

  // 2. 64-char hex: check Transaction Hash -> Block Hash -> Asset ID
  if (/^[0-9a-fA-F]{64}$/.test(q)) {
    const hex = q.toLowerCase();
    const txRes = await numistaRpc._daemonRaw('get_transactions', { txs_hashes: [hex], decode_as_json: true }).catch(() => null);
    if (txRes?.txs?.length) {
      const tx = txRes.txs;
      let parsed = null;
      try { parsed = JSON.parse(tx.as_json || '{}'); } catch {}
      const matchingJob = (gameStore.mintLedger || []).find(b => b.txHash === hex) || null;
      return {
        kind: 'transaction',
        txHash: hex,
        inPool: Boolean(tx.in_pool),
        blockHeight: tx.block_height ?? null,
        blockTimestamp: tx.block_timestamp ? new Date(tx.block_timestamp * 1000).toISOString() : null,
        numistaAssetOp: parsed?.numista_asset_op || parsed?.extra || parsed,
        mintBatch: matchingJob
      };
    }
    const blkByHash = await numistaRpc._daemonJsonRpc('get_block', { hash: hex }).catch(() => null);
    if (blkByHash?.block_header) {
      const hdr = blkByHash.block_header;
      return {
        kind: 'block',
        height: hdr.height,
        hash: hdr.hash,
        prevHash: hdr.prev_hash,
        timestamp: hdr.timestamp ? new Date(hdr.timestamp * 1000).toISOString() : null,
        difficulty: hdr.difficulty,
        rewardNum: +(Number(hdr.reward || 0) / 1e12).toFixed(4),
        txHashes: blkByHash.tx_hashes || []
      };
    }
    const asset = await numistaRpc.getAsset(hex).catch(() => null);
    if (asset) return { kind: 'asset', assetId: hex, asset };
    throw new Error('64-hex hash not found as transaction, block, or asset on-chain');
  }

  // 3. Pre-1920 Coin Serial (COIN-YYYY-XXXXXX)
  if (/^COIN-\d{4}-\d+$/i.test(q)) {
    const serial = q.toUpperCase();
    const aid = coinAssetId(serial);
    const asset = await numistaRpc.getAsset(aid).catch(() => null);
    const allCoins = gameStore.getMintLedger(500).flatMap(b => b.coins || []);
    const coin = allCoins.find(c => String(c.serial).toUpperCase() === serial) || null;
    const onChainBal = coin?.owner ? await numistaRpc.getAssetBalance(aid, coin.owner).catch(() => null) : null;
    return { kind: 'coin', serial, assetId: aid, coin, onChainAsset: asset, verifiedOwnerOnChain: onChainBal };
  }

  // 4. UK Plot ID (uk-XXXX)
  if (/^uk-\d+$/i.test(q)) {
    const plotId = q.toLowerCase();
    const plot = gameStore.getPlotById(plotId);
    const aid = deedAssetId(plotId);
    const asset = await numistaRpc.getAsset(aid).catch(() => null);
    const onChainOwnerMatches = plot?.owner ? await numistaRpc.getAssetBalance(aid, plot.owner).catch(() => null) : null;
    return { kind: 'plot', plotId, deedAssetId: aid, plot, onChainAsset: asset, verifiedOwnerOnChain: onChainOwnerMatches };
  }

  // 5. Wallet Address (Sb... or UGN...)
  if (/^(Sb|UGN)[1-9A-HJ-NP-Za-km-z]{80,}$/.test(q)) {
    const accts = await numistaRpc._walletRpc('get_accounts', {}).catch(() => null);
    const match = (accts?.subaddress_accounts || []).find(a => a.base_address === q);
    if (!match) throw new Error('Address not found in node wallet');
    const lbl = String(match.label || '');
    const at = lbl.indexOf('@'), h = lbl.lastIndexOf('#');
    const uname = at !== -1 ? lbl.slice(at + 1, h !== -1 ? h : undefined).trim().toLowerCase() : (match.account_index === 0 ? 'danie' : `unknown_${match.account_index}`);
    return { kind: 'address', address: q, accountIndex: match.account_index, username: uname, nativeBalanceNum: +(Number(match.balance || 0) / 1e12).toFixed(4) };
  }

  // 6. @Username / Handle
  const uname = q.replace(/^@/, '').toLowerCase();
  const reg = await numistaRpc.getAssetUsernameKey(uname).catch(() => null);
  const coins = gameStore.getMintLedger(500).flatMap(b => b.coins || []).filter(c => String(c.owner || '').toLowerCase() === uname);
  const ownedPlots = (gameStore.plots || []).filter(p => p.isClaimed && String(p.owner || '').toLowerCase() === uname).map(p => ({ id: p.id, label: p.label, tier: p.tier }));
  return { kind: 'username', username: `@${uname}`, onChainKey: reg, title: (gameStore.playerTitles || {})[uname] || null, coinsCount: coins.length, coins, ownedPlots };
}