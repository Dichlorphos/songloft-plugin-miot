// 状态机出口 → 播放观测的映射。
//
// 单独成文件是为了让「出口该报什么」变成可测的纯函数：PlaylistManager 负责在正确的
// 出口调用它，范围判定与字段规整由 recorder 负责。
//
// 位置口径：playing 用本地推算位置，paused 用暂停时抓到的位置，stopped 用停止前位置。
// 这三者在 PlaylistManager 里是三个不同字段，混用会让恢复位置错位。
//
// 本层只做忠实映射，不施加范围策略：电台位置归零、playlist_id 置空、位置可用性等
// 规则统一由 recorder 施加，避免同一条规则在两个模块各写一份。

import type { PlaybackObservation } from './recorder.ts';
import type { PlaybackSnapshotState } from './snapshot_store.ts';

/** PlaylistManager 在状态出口处提供的原始状态快照。 */
export interface ManagerExitState {
  account_id: string;
  device_id: string;
  /** 正式歌单 ID；电台与临时歌单为 null。 */
  playlist_id: number | null;
  song_id: number;
  song_index: number;
  /** 宿主歌曲类型：local / remote / radio。 */
  song_type: string;
  state: PlaybackSnapshotState;
  /** playing 态由墙钟推算的曲内位置。 */
  local_position: number;
  /** 暂停时抓取的位置。 */
  paused_position: number;
  /** 停止前的位置。 */
  stop_position: number;
  position_available: boolean;
  speed: number;
  play_mode: string;
  target_count: number;
  title: string;
  artist: string;
}

/** 按出口状态选择正确的位置来源。 */
function positionFor(state: ManagerExitState): number {
  if (state.state === 'paused') return state.paused_position;
  if (state.state === 'stopped') return state.stop_position;
  return state.local_position;
}

/** 把状态机出口映射为观测；歌曲身份无效时返回 null。 */
export function buildObservation(state: ManagerExitState): PlaybackObservation | null {
  if (!state.account_id || !Number.isInteger(state.song_id) || state.song_id <= 0) return null;

  return {
    account_id: state.account_id,
    content_type: state.song_type === 'radio' ? 'radio' : 'playlist',
    song_id: state.song_id,
    playlist_id: state.playlist_id,
    song_index: state.song_index,
    position_sec: Math.max(0, positionFor(state)),
    position_available: state.position_available,
    speed: state.speed,
    play_mode: state.play_mode,
    state: state.state,
    source_device: { account_id: state.account_id, device_id: state.device_id },
    target_count: state.target_count,
    title: state.title,
    artist: state.artist,
  };
}