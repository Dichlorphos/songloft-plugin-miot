// 插件重启后的播放状态恢复必须用「硬条件」，不能用锚点年龄过期来兜。
//
// 背景：`resumeAfterReload` 原先在「设备没在放我们的流」时会调用 playCurrent 重推 URL。
// 服务停了一夜、第二天有人打开网页才惰性建 manager 时，这条路径会把音箱叫起来放歌
// （songloft-org/songloft-plugin-miot#96）。用「锚点超过 5 分钟就不恢复」当判据方向错了：
// 重启本来就不是正常路径，真正可靠的信号是设备此刻的状态。
//
// 两条硬条件：
//   判据 1（兜底，不依赖宿主改动）：`playing` 锚点只有「设备此刻确实在放我们这条流」才接管；
//     设备没在放、在放别的媒体、状态查不到、流长对不上，一律钉死 `stopped` 并记下停止位置。
//     任何情况下都不再重推 URL。
//   判据 3：上次是异常终止（onDeinit 没走完，清洁停机标记缺失）时，无论设备状态如何都不接管。
// `paused` / `stopped` 锚点只恢复本地状态、不碰设备；停止位置必须活过重启。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConfigManager } from '../config/manager.ts';
import { PlaylistManager, PlaylistManagerMap } from './manager.ts';
import { setHostBaseUrl } from '../utils/http.ts';

const SONG = { id: 11, type: 'remote', title: 'T', artist: 'A', duration: 200, url: '/api/v1/songs/11/play' };

/** 内存 storage 的宿主替身；不触碰真实用户数据。 */
function installFakeHost() {
  const storage = new Map<string, string>();
  (globalThis as any).songloft = {
    storage: {
      async get(key: string) { return storage.has(key) ? storage.get(key)! : null; },
      async set(key: string, value: string) { storage.set(key, value); },
      async delete(key: string) { storage.delete(key); },
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    plugin: {
      async getToken() { return 't'; },
      async getHostUrl() { return 'http://127.0.0.1:9999'; },
    },
    playlists: {
      async getById(id: number) { return { id, sort_by: '', sort_order: 'asc' }; },
      async getSongs() { return [SONG]; },
    },
    songs: { async getById() { return null; } },
  };
  return { storage };
}

/** 记录下发 URL 与设备状态查询次数的 MinaService 替身。 */
function makeFakeMina(deviceState: { status: number; position: number; duration: number }) {
  const urls: string[] = [];
  let queries = 0;
  return {
    urls,
    get queries() { return queries; },
    async playURL(_accountId: string, _deviceId: string, url: string) { urls.push(url); return true; },
    async getPlayState() { queries++; return deviceState; },
    async pausePlayVerified() { return 'paused' as const; },
    async pausePlay() { return true; },
    async resumePlay() { return true; },
    async stopPlay() { return true; },
    async textToSpeech() {},
  };
}

/** 建一个「刚 initWithSongs 完、还没人动过」的空闲管理器，模拟插件重启后的状态。 */
function makeIdleManager(deviceState: { status: number; position: number; duration: number }) {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  const config = new ConfigManager();
  const mina = makeFakeMina(deviceState);
  const manager = new PlaylistManager('acc1', 'devA', mina as any, config);
  manager.initWithSongs([SONG as any], 0, 'order', 7);
  return { manager, mina, config };
}

function anchorOf(overrides: Partial<{ state: string; positionSec: number; atMs: number; songId: number; seekOffsetSec: number }> = {}) {
  return {
    state: 'playing',
    positionSec: 40,
    atMs: Date.now() - 5000,
    songId: 11,
    seekOffsetSec: 0,
    ...overrides,
  };
}

function seedAccount(storage: Map<string, string>, deviceOverrides: Record<string, unknown> = {}) {
  storage.set('accounts', JSON.stringify([{
    id: 'acc1', account: 'a', auth_type: 'password', login_method: 'password', password: '',
    pass_token: '', user_id: 'u', services: {}, last_selected_device_id: 'devA',
    created_at: '', updated_at: '',
    devices: [{
      device_id: 'devA', device_name: 'D', model: 'm', hardware: 'h', alias: 'A',
      managed: true, volume: 50, play_mode: 'order', play_speed: 1, playlist_id: 7,
      current_song_index: 0, last_selected_at: '',
      ...deviceOverrides,
    }],
  }]));
}

test('判据 1：playing 锚点但设备已不在播放 → 钉死 stopped，不重推 URL', async () => {
  const { manager, mina } = makeIdleManager({ status: 2, position: 0, duration: 0 });
  try {
    await manager.resumeAfterReload(anchorOf(), { allowTakeover: true });

    assert.equal(manager.getStatus().state, 'stopped', '设备没在放就必须钉死 stopped');
    assert.deepEqual(mina.urls, [], '重启恢复绝不能重推 URL 把音箱叫起来');
    const stopped = (manager as any).lastStopPositionSec;
    assert.ok(Math.abs(stopped - 45) < 2, `应按锚点外推记下停止位置（约 45s），实际 ${stopped}`);
  } finally { manager.cleanup(); }
});

test('判据 1：playing 锚点且设备仍在放我们的流 → 只接管定时器', async () => {
  // 流从歌曲第 30s 开始、原速，所以设备上报流长 170s 即「我们的流」。
  const { manager, mina } = makeIdleManager({ status: 1, position: 15, duration: 170 });
  try {
    await manager.resumeAfterReload(anchorOf({ seekOffsetSec: 30 }), { allowTakeover: true });

    assert.equal(manager.getStatus().state, 'playing', '设备真的在放我们的流时应接管');
    assert.deepEqual(mina.urls, [], '接管不得重推 URL');
    assert.ok((manager as any).checkTimer !== null, '接管后必须把自动切歌定时器接回来');
    const position = manager.getPosition();
    assert.ok(Math.abs(position - 45) < 2, `位置应采用设备实测（15+30=45s），实际 ${position}`);
  } finally { manager.cleanup(); }
});

test('判据 1：设备在播但流长对不上（可能被别的媒体接管）→ 钉死 stopped', async () => {
  const { manager, mina } = makeIdleManager({ status: 1, position: 15, duration: 600 });
  try {
    await manager.resumeAfterReload(anchorOf(), { allowTakeover: true });

    assert.equal(manager.getStatus().state, 'stopped', '流长对不上不能接管');
    assert.deepEqual(mina.urls, [], '不得重推 URL');
  } finally { manager.cleanup(); }
});

test('判据 1：设备在播但流长未上报（unknown）→ 钉死 stopped', async () => {
  const { manager, mina } = makeIdleManager({ status: 1, position: 15, duration: 0 });
  try {
    await manager.resumeAfterReload(anchorOf(), { allowTakeover: true });

    assert.equal(manager.getStatus().state, 'stopped', '无法确证是我们的流时按停止处理');
    assert.deepEqual(mina.urls, [], '不得重推 URL');
  } finally { manager.cleanup(); }
});

test('旧数据缺 atMs：不外推出天文数字位置，仍按设备状态决定是否接管', async () => {
  const { manager, mina } = makeIdleManager({ status: 2, position: 0, duration: 0 });
  try {
    await manager.resumeAfterReload(anchorOf({ atMs: 0 }), { allowTakeover: true });

    assert.equal(manager.getStatus().state, 'stopped');
    assert.deepEqual(mina.urls, [], '不得重推 URL');
    const stopped = (manager as any).lastStopPositionSec;
    assert.ok(stopped >= 40 && stopped < 60, `位置应接近锚点值而非天文数字，实际 ${stopped}`);
  } finally { manager.cleanup(); }
});
test('判据 3：异常终止（清洁停机标记缺失）时，设备真的在放也不接管、不查设备', async () => {
  const { manager, mina } = makeIdleManager({ status: 1, position: 15, duration: 170 });
  try {
    await manager.resumeAfterReload(anchorOf(), { allowTakeover: false });

    assert.equal(manager.getStatus().state, 'stopped', '异常终止后一律钉死 stopped');
    assert.deepEqual(mina.urls, [], '不得重推 URL');
    assert.equal(mina.queries, 0, '硬否决时连设备状态都不必问');
    assert.ok((manager as any).lastStopPositionSec > 0, '仍要记下停止位置供用户明确继续');
  } finally { manager.cleanup(); }
});

test('钉死后立即落盘：第二次重启读到 stopped，不再查设备也不再重推', async () => {
  const { storage } = installFakeHost();
  seedAccount(storage, {
    resume_state: 'playing', resume_position_sec: 40, resume_at_ms: Date.now() - 5000,
    resume_song_id: 11, resume_seek_offset_sec: 0,
  });
  setHostBaseUrl('http://127.0.0.1:9999');
  const config = new ConfigManager();

  // 第一次重启：设备没在放我们的流 → 钉死 stopped 并落盘
  {
    const mina = makeFakeMina({ status: 2, position: 0, duration: 0 });
    const manager = new PlaylistManager('acc1', 'devA', mina as any, config);
    manager.initWithSongs([SONG as any], 0, 'order', 7);
    await manager.resumeAfterReload(anchorOf(), { allowTakeover: true });
    assert.equal(manager.getStatus().state, 'stopped');
    manager.cleanup();
  }

  const dev = JSON.parse(storage.get('accounts')!)[0].devices[0];
  assert.equal(dev.resume_state, 'stopped', '钉死结果必须落盘');
  assert.ok(Math.abs(dev.resume_position_sec - 45) < 2, `停止位置应约 45s，实际 ${dev.resume_position_sec}`);

  // 第二次重启：读到 stopped，直接还原本地状态，连一次设备查询都不该发生
  {
    const mina = makeFakeMina({ status: 1, position: 15, duration: 170 });
    const manager = new PlaylistManager('acc1', 'devA', mina as any, config);
    manager.initWithSongs([SONG as any], 0, 'order', 7);
    await manager.resumeAfterReload({
      state: dev.resume_state, positionSec: dev.resume_position_sec, atMs: dev.resume_at_ms,
      songId: dev.resume_song_id, seekOffsetSec: dev.resume_seek_offset_sec,
    }, { allowTakeover: true });

    assert.equal(manager.getStatus().state, 'stopped', 'stopped 锚点不得自动起播');
    assert.equal(mina.queries, 0, 'stopped 锚点不该查询设备');
    assert.deepEqual(mina.urls, [], 'stopped 锚点不该下发');
    assert.ok((manager as any).lastStopPositionSec > 40, '停止位置跨重启保留');
    manager.cleanup();
  }
});
test('paused 锚点：只恢复暂停位置，不碰设备', async () => {
  const { manager, mina } = makeIdleManager({ status: 1, position: 15, duration: 170 });
  try {
    await manager.resumeAfterReload(anchorOf({ state: 'paused', positionSec: 66 }), { allowTakeover: true });

    assert.equal(manager.getStatus().state, 'paused');
    assert.equal((manager as any).pausedPositionSec, 66);
    assert.deepEqual(mina.urls, [], '恢复暂停态不得下发任何命令');
    assert.equal(mina.queries, 0, '恢复暂停态不需要查设备');
  } finally { manager.cleanup(); }
});

test('停止位置写入锚点：stop() 把 stopped 状态与位置一起落盘', async () => {
  const { storage } = installFakeHost();
  seedAccount(storage);
  setHostBaseUrl('http://127.0.0.1:9999');
  const config = new ConfigManager();
  const mina = makeFakeMina({ status: 1, position: 0, duration: 200 });
  const manager = new PlaylistManager('acc1', 'devA', mina as any, config);
  try {
    manager.initWithSongs([SONG as any], 0, 'order', 7);
    (manager as any).state = 'playing';
    (manager as any).playStartTimeMs = Date.now() - 42 * 1000;

    await manager.stop();

    const accounts = JSON.parse(storage.get('accounts')!);
    const dev = accounts[0].devices[0];
    assert.equal(dev.resume_state, 'stopped', '停止态必须落盘（活过重启）');
    assert.ok(Math.abs(dev.resume_position_sec - 42) < 2, `停止位置应约 42s，实际 ${dev.resume_position_sec}`);
    assert.equal(dev.resume_song_id, 11, '停止位置必须绑定到具体歌曲');
  } finally { manager.cleanup(); }
});

test('stopped 锚点：restoreFromConfig 还原后位置仍在，且用户继续能从该位置续播', async () => {
  const { storage } = installFakeHost();
  seedAccount(storage, {
    resume_state: 'stopped', resume_position_sec: 42, resume_at_ms: Date.now(),
    resume_song_id: 11, resume_seek_offset_sec: 0,
  });
  setHostBaseUrl('http://127.0.0.1:9999');
  const config = new ConfigManager();
  const mina = makeFakeMina({ status: 2, position: 0, duration: 0 });
  const map = new PlaylistManagerMap(mina as any, config);
  const manager = new PlaylistManager('acc1', 'devA', mina as any, config);
  try {
    const anchor = await (map as any).restoreFromConfig(manager, 'acc1', 'devA');
    assert.ok(anchor, 'stopped 锚点必须能被还原（此前只在 playing/paused 时返回）');
    assert.equal(anchor.state, 'stopped');
    assert.equal(anchor.positionSec, 42);

    await manager.resumeAfterReload(anchor, { allowTakeover: true });
    assert.equal(manager.getStatus().state, 'stopped', 'stopped 不该自动起播');
    assert.equal((manager as any).lastStopPositionSec, 42, '停止位置要活过重启');
    assert.deepEqual(mina.urls, [], '还原 stopped 时不得下发');

    await manager.replayCurrentFromStop();
    assert.equal(mina.urls.length, 1, '用户明确继续时才重推 URL');
    assert.match(mina.urls[0], /seek=4[0-4]/, `应从停止位置继续，实际 ${mina.urls[0]}`);
  } finally { manager.cleanup(); }
});

test('清洁停机标记：正常停止才置位，读取后即清除，缺失按异常终止处理', async () => {
  const { storage } = installFakeHost();
  const config = new ConfigManager();

  assert.equal(await config.consumeCleanShutdownFlag(), false, '首次启动没有标记 → 按异常终止处理');

  await config.markCleanShutdown();
  assert.equal(storage.get('clean_shutdown'), 'true', 'onDeinit 必须写入清洁停机标记');
  assert.equal(await config.consumeCleanShutdownFlag(), true, 'onInit 读到标记 = 上次正常停止');
  assert.equal(storage.has('clean_shutdown'), false, '读取后必须清除');
  assert.equal(await config.consumeCleanShutdownFlag(), false, '清除后再次读取按异常终止处理');
});

test('清洁停机标记清除失败时必须按异常终止处理（否则陈旧标记会放行下次崩溃）', async () => {
  // 标记是一次性的。若 delete 失败却仍按 raw 值放行，这个陈旧标记会留在存储里，
  // 让「之后那次崩溃」的启动也读到它——正是防隔夜叫醒机制要挡住的情形。
  const { storage } = installFakeHost();
  const config = new ConfigManager();
  await config.markCleanShutdown();

  const songloftRef = (globalThis as unknown as { songloft: { storage: { delete(key: string): Promise<void> } } }).songloft;
  const originalDelete = songloftRef.storage.delete;
  songloftRef.storage.delete = async () => { throw new Error('storage delete failed'); };

  try {
    assert.equal(
      await config.consumeCleanShutdownFlag(),
      false,
      '清除失败不能放行：保守方向是多一次不自动续播',
    );
  } finally {
    songloftRef.storage.delete = originalDelete;
  }

  // 删除失败虽然改了写，但本次仍必须不放行——这正是原缺陷：delete 抛错后照样 return raw。
  // 改写的作用只是让它不再是可信值（只判 true / 'true'），别留给下一次启动。
  assert.notEqual(storage.get('clean_shutdown'), 'true', '陈旧标记必须被改写失效，不能留 true 在存储里');
});

test('清洁停机标记删除与改写都失败时，仍必须按异常终止处理', async () => {
  const { storage } = installFakeHost();
  const config = new ConfigManager();
  await config.markCleanShutdown();

  const songloftRef = (globalThis as unknown as {
    songloft: { storage: { delete(k: string): Promise<void>; set(k: string, v: string): Promise<void> } };
  }).songloft;
  const originalDelete = songloftRef.storage.delete;
  const originalSet = songloftRef.storage.set;
  songloftRef.storage.delete = async () => { throw new Error('delete failed'); };
  songloftRef.storage.set = async () => { throw new Error('set failed'); };

  try {
    assert.equal(
      await config.consumeCleanShutdownFlag(),
      false,
      '确认不了清除就必须按异常终止处理',
    );
  } finally {
    songloftRef.storage.delete = originalDelete;
    songloftRef.storage.set = originalSet;
  }

  // 已知残余限制：删除与改写都失败时存储里会残留 true，下次启动读到它只能放行。
  // 那种情况下存储整体不可写，无法让一次性标记失效；这里如实钉住当前行为，
  // 免得将来误以为已被根治。
  assert.equal(storage.get('clean_shutdown'), 'true', '存储整体不可写时确实无法让标记失效（已知限制）');
});

test('接线：onInit 读并清标记后注入 map，onDeinit 写标记', async () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const main = read('../main.ts');
  const manager = read('./manager.ts');

  assert.match(main, /const lastShutdownClean = await configManager\.consumeCleanShutdownFlag\(\)/,
    'onInit 必须读取清洁停机标记');
  const consumeIdx = main.indexOf('consumeCleanShutdownFlag');
  const mapCtorIdx = main.indexOf('playlistManagerMap = new PlaylistManagerMap(');
  assert.ok(consumeIdx > 0 && consumeIdx < mapCtorIdx, '必须在建 manager 之前读取标记');
  assert.match(main, /playlistManagerMap\.setLastShutdownClean\(lastShutdownClean\)/,
    'onInit 必须把停机结果注入 PlaylistManagerMap');
  assert.match(main, /await configManager\?\.markCleanShutdown\(\)/,
    'onDeinit 必须写下清洁停机标记');

  assert.match(manager, /allowTakeover: this\.lastShutdownClean/,
    'map 必须把清洁停机标记传给 resumeAfterReload');
});
