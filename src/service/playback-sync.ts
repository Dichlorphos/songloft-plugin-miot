import type { PlayerStatus, PlaybackSnapshot } from '../types';
import { ConfigManager } from '../config/manager';

export const PLAYBACK_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

export class PlaybackSyncService {
  constructor(private readonly configManager: ConfigManager) {}

  async get(accountId: string): Promise<PlaybackSnapshot | null> {
    const snapshot = await this.configManager.getPlaybackSnapshot(accountId);
    return snapshot && !this.isExpired(snapshot) ? snapshot : null;
  }

  isExpired(snapshot: PlaybackSnapshot, now = Date.now()): boolean {
    return !Number.isFinite(snapshot.updatedAt) || now - snapshot.updatedAt > PLAYBACK_SNAPSHOT_TTL_MS;
  }

  async record(accountId: string, sourceDeviceId: string, status: PlayerStatus): Promise<PlaybackSnapshot | null> {
    if (!accountId || !sourceDeviceId || !status || !['playing', 'paused', 'stopped'].includes(status.state) || !status.current_song || status.playlist_id <= 0) return null;
    const snapshot: PlaybackSnapshot = {
      accountId, sourceDeviceId, playlistId: status.playlist_id, songId: status.current_song.id,
      songIndex: status.current_index, positionSec: Math.max(0, status.position || 0),
      durationSec: Math.max(0, status.duration || 0), speed: status.speed || 1,
      state: status.state, updatedAt: Date.now(),
    };
    await this.configManager.savePlaybackSnapshot(snapshot);
    return snapshot;
  }
}
