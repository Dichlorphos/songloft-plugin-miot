// 切换编排的宿主装配：把设备选择、播放管理器和采样能力接到 SwitchCoordinator。
//
// 纯逻辑在 switch_coordinator.ts；这里只做宿主适配，便于用手动 fake 驱动集成测试。
// 采样必须读设备物理位置：getPlayState 返回的是流内偏移，带 seek/倍速的流要换算成
// 曲内绝对位置（×speed + streamSeekOffset），与 handlers/playlist.ts 的口径一致。

import type { PlaylistManager, PlaylistManagerMap } from '../player/manager.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { LoadedSong } from './switch_coordinator.ts';
import type { PlayMode } from '../types.ts';


export interface HostPlaybackDeps {
  playlistManagerMap: PlaylistManagerMap;
  minaService: {
    getPlayState(accountId: string, deviceId: string): Promise<{ status: number; position: number; duration: number }>;
  };
}

/**
 * 采样源设备物理位置并换算成曲内绝对位置。
 *
 * 设备上报的是「当前流的流内偏移」；带 seek 的流要从 streamSeekOffsetSec 起算，
 * 带倍速的流还要乘 speed。采样失败（拿不到状态）返回 null，由协调器保留旧快照。
 */
export async function sampleSourcePosition(
  manager: PlaylistManager | null,
  minaService: HostPlaybackDeps['minaService'],
  accountId: string,
  deviceId: string,
): Promise<number | null> {
  try {
    const state = await minaService.getPlayState(accountId, deviceId);
    if (!state || state.status < 0) return null;
    const offset = manager?.getStreamSeekOffsetSec() ?? 0;
    const speed = manager?.getPlaybackSpeed() ?? 1;
    return Math.max(0, state.position * speed + offset);
  } catch {
    return null;
  }
}

/** 按 song_id 取回宿主歌曲对象；取不到返回 null。 */
export async function loadSongById(songId: number): Promise<any | null> {
  try {
    const song = await songloft.songs.getById(songId);
    return song ?? null;
  } catch {
    return null;
  }
}

/**
 * 设备是否属于一个 ≥2 成员的设备组；组成员完全跳过同步。
 *
 * 读配置失败时**抛出**，由调用方按「无法排除设备组」保守跳过。绝不能返回 false：
 * 那等于宣称「这是独立设备」，会把设备组当成独立设备产生跨设备上下文。
 */
export async function isDeviceInGroup(configManager: ConfigManager, accountId: string, deviceId: string): Promise<boolean> {
  const groups = await configManager.getDeviceGroups();
  return groups.some(g =>
    Array.isArray(g?.members) && g.members.length >= 2 &&
    g.members.some(m => m?.account_id === accountId && m?.device_id === deviceId));
}

/**
 * 把 pending 上下文下发给目标设备。
 *
 * 命中歌曲对象后按歌单/歌曲/位置/模式下发；成功返回 succeeded。这里复用现有
 * PlaylistManager 的准备与下发能力，不新增切换 API。
 */
export async function playPendingContext(
  playlistManagerMap: PlaylistManagerMap,
  accountId: string,
  targetDeviceId: string,
  playlistId: number,
  song: LoadedSong,
  songIndex: number,
  positionSec: number,
  mode: string,
  speed: number,
): Promise<'succeeded' | 'failed' | 'unknown'> {
  try {
    const manager = await playlistManagerMap.getOrCreate(accountId, targetDeviceId);
    manager.setAnnounceOnSongChange(false);

    // 目标设备可能持有不同的歌单：只要它能加载到该歌曲就按 pending 恢复。
    const targetPlaylistId = Number.isInteger(playlistId) && playlistId > 0 ? playlistId : 0;
    const ok = await manager.gracefulPlay(
      targetPlaylistId,
      song,
      songIndex,
      positionSec,
      mode as PlayMode,
      speed,
    );
    return ok ? 'succeeded' : 'failed';
  } catch (e) {
    songloft.log.warn(`[playback_sync] play pending failed: ${String(e)}`);
    return 'unknown';
  }
}

