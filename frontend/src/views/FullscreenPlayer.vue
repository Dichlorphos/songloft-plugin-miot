<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSongCover } from '../covers';
import PlayerModePopup from './PlayerModePopup.vue';
import PlayerSpeedPopup from './PlayerSpeedPopup.vue';
import PlayerProgress from './PlayerProgress.vue';
import PlayerSleepTimerPopup from './PlayerSleepTimerPopup.vue';
import PlayerVolumePopup from './PlayerVolumePopup.vue';
import SlButton from '../ui/SlButton.vue';
import SlIcon from '../ui/SlIcon.vue';
import { closePage, navigation, notifyHostFavorite } from '../runtime';
import { get, messageOf, post, query } from '../api';
import type { SleepTimerStatus } from '../types';
import { notify, playerCommand, seekPlayer, setPlayMode, setPlaybackSpeed, setVolume, state } from '../store';

interface LyricLine { time: number; text: string }
interface LyricPayload { lyric?: string; tlyric?: string; rlyric?: string; lxlyric?: string }
const lyrics = ref<LyricLine[]>([]);
const isFavorite = ref(false);
const favoriteBusy = ref(false);
const sleepTimerBusy = ref(false);
const sleepTimer = ref<SleepTimerStatus>({ active: false, mode: 'time', remaining: 0, total: 0 });
const mobilePager = ref<HTMLElement | null>(null);
const mobilePage = ref(0);
const desktopLyrics = ref<HTMLElement | null>(null);
const mobileLyrics = ref<HTMLElement | null>(null);
let touchStartX = 0;
let touchStartY = 0;
let touchStartPage = 0;
let mobileScrollTimer = 0;
let mobileSettledPage = 0;
const activeLyric = computed(() => {
  const position = Number(state.player.position || 0);
  let index = -1;
  lyrics.value.forEach((line, i) => { if (line.time <= position) index = i; });
  return index;
});
// 桌面与移动 stage **同时**在 DOM 里（只靠媒体查询 `display:none` 切换），所以这里
// 刻意开两份、并用不同的 `w=`：
//   ① 尺寸本来就不同（桌面 frame 360px、移动 72vw/max 320px），各取 2x 更合理；
//   ② 更要紧的是别让两个 `<img>` 落到同一个 URL 上 —— WebF 的 `_loadNormalImage`
//      会 `evict(BoxFitImageKey(url, ImageConfiguration.empty), includeLive: true)`
//      紧接着又用同一个 key 去 resolve，同 URL 的两个 img 会互相把对方（连同已解码的
//      `ui.Image`）毙掉，表现是空白且**不发 error 事件**（#86 的可疑主因之一）。
const { src: cover, epoch: coverEpoch, onError: onCoverError, onLoad: onCoverLoad } = useSongCover(() => state.player.current_song, 768);
const { src: coverMobile, epoch: coverMobileEpoch, onError: onCoverMobileError, onLoad: onCoverMobileLoad } = useSongCover(() => state.player.current_song, 640);

function parseLrc(text: string): LyricLine[] {
  const output: LyricLine[] = [];
  const plain: string[] = [];
  const wordTimestamp = /\[\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\]/g;
  const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const normalized = line.replace(wordTimestamp, '');
    const matches = [...normalized.matchAll(timestamp)];
    const content = normalized
      .replace(timestamp, '')
      .replace(/<\d+,\d+>/g, '')
      .trim();
    if (!content) continue;
    plain.push(content);
    for (const match of matches) {
      const fraction = (match[3] || '').padEnd(3, '0').slice(0, 3);
      output.push({
        time: Number(match[1]) * 60 + Number(match[2]) + Number(fraction || 0) / 1000,
        text: content,
      });
    }
  }
  if (output.length) return output.sort((a, b) => a.time - b.time);
  return plain.map((line) => ({ time: Number.POSITIVE_INFINITY, text: line }));
}

async function loadSongDetails(): Promise<void> {
  const songId = state.player.current_song?.id;
  if (!songId) {
    lyrics.value = [];
    isFavorite.value = false;
    return;
  }
  const [lyricResult, favoriteResult] = await Promise.allSettled([
    get<LyricPayload>(`/lyric?song_id=${songId}`),
    get<{ is_favorited: boolean }>(`/player/favorite/status?song_id=${songId}`),
  ]);
  if (lyricResult.status === 'fulfilled') {
    const result = lyricResult.value;
    const text = String(result.lyric || result.lxlyric || result.tlyric || result.rlyric || '');
    lyrics.value = parseLrc(text);
  } else {
    lyrics.value = [];
  }
  isFavorite.value = favoriteResult.status === 'fulfilled' && favoriteResult.value.is_favorited;
}

async function toggleFavorite(): Promise<void> {
  const id = state.player.current_song?.id;
  if (!id || favoriteBusy.value) return;
  const previous = isFavorite.value;
  const next = !previous;
  isFavorite.value = next;
  favoriteBusy.value = true;
  try {
    const result = await post<{ is_favorited: boolean }>('/player/favorite/toggle', {
      song_id: id,
      action: next ? 'add' : 'remove',
    });
    isFavorite.value = result.is_favorited;
    notify(result.is_favorited ? '已收藏' : '已取消收藏', 'success', 1800);
    notifyHostFavorite(id, result.is_favorited);
  } catch (error) {
    isFavorite.value = previous;
    notify(messageOf(error), 'error');
  } finally {
    favoriteBusy.value = false;
  }
}

async function loadSleepTimer(): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId) {
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
    return;
  }
  try {
    sleepTimer.value = await get<SleepTimerStatus>(`/voice-commands/sleep-timer${query({
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    })}`);
  } catch {
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
  }
}

async function setSleepTimer(mode: 'time' | 'songs', value: number): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId || sleepTimerBusy.value) return;
  sleepTimerBusy.value = true;
  try {
    sleepTimer.value = await post<SleepTimerStatus>('/voice-commands/sleep-timer', {
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
      mode,
      value,
    });
    navigation.playerPopup = '';
    notify(mode === 'time' ? `将在 ${value} 分钟后停止` : `将在播放 ${value} 首后停止`, 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    sleepTimerBusy.value = false;
  }
}

async function cancelSleepTimer(): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId || sleepTimerBusy.value) return;
  sleepTimerBusy.value = true;
  try {
    await post<{ cancelled: boolean }>('/voice-commands/sleep-timer/cancel', {
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    });
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
    navigation.playerPopup = '';
    notify('已取消延迟停止', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    sleepTimerBusy.value = false;
  }
}

function close(): void {
  navigation.playerPopup = '';
  closePage();
}

function syncMobilePage(): void {
  const pager = mobilePager.value;
  if (!pager || pager.clientWidth <= 0) return;
  const ratio = Math.max(0, Math.min(1, pager.scrollLeft / pager.clientWidth));
  const page = mobileSettledPage === 0
    ? (ratio >= 0.12 ? 1 : 0)
    : (ratio <= 0.88 ? 0 : 1);
  window.clearTimeout(mobileScrollTimer);
  mobileScrollTimer = window.setTimeout(() => {
    const currentPager = mobilePager.value;
    if (!currentPager || currentPager.clientWidth <= 0) return;
    mobileSettledPage = page;
    mobilePage.value = page;
    const target = currentPager.clientWidth * page;
    if (Math.abs(currentPager.scrollLeft - target) > 1) currentPager.scrollLeft = target;
  }, 120);
}

function showMobilePage(index: number): void {
  const pager = mobilePager.value;
  mobileSettledPage = index;
  mobilePage.value = index;
  if (!pager) return;
  window.clearTimeout(mobileScrollTimer);
  pager.scrollLeft = pager.clientWidth * index;
}

function startMobileSwipe(event: TouchEvent): void {
  const touch = event.touches[0];
  if (!touch) return;
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchStartPage = mobilePage.value;
}

function finishMobileSwipe(event: TouchEvent): void {
  const touch = event.changedTouches[0];
  if (!touch) return;
  const deltaX = touch.clientX - touchStartX;
  const deltaY = touch.clientY - touchStartY;
  if (Math.abs(deltaX) >= 36 && Math.abs(deltaX) > Math.abs(deltaY)) {
    showMobilePage(Math.max(0, Math.min(1, touchStartPage + (deltaX < 0 ? 1 : -1))));
    return;
  }
  window.setTimeout(syncMobilePage, 80);
}

async function centerActiveLyric(): Promise<void> {
  if (navigation.page !== 'player') return;
  await nextTick();
  for (const panel of [desktopLyrics.value, mobileLyrics.value]) {
    if (!panel || panel.clientHeight <= 0) continue;
    const active = panel.querySelector<HTMLElement>('.lyric-line.active');
    if (!active) continue;
    const top = active.offsetTop - panel.clientHeight / 2 + active.offsetHeight / 2;
    try {
      panel.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } catch {
      panel.scrollTop = Math.max(0, top);
    }
  }
}

onMounted(() => {
  void loadSongDetails();
  void loadSleepTimer();
});
onUnmounted(() => window.clearTimeout(mobileScrollTimer));
watch(() => state.player.current_song?.id, loadSongDetails);
watch(() => [state.currentAccountId, state.currentDeviceId], loadSleepTimer);
watch(activeLyric, centerActiveLyric);
</script>

<template>
  <div class="fullscreen-player page-view">
    <div class="fullscreen-close-button">
      <SlButton variant="icon" icon="keyboard_arrow_down" class="player-tool-button" title="收起播放器" @click="close" />
    </div>
    <main class="fullscreen-inner">
      <div class="fullscreen-layout">
        <div class="fullscreen-stage">
          <div class="fullscreen-desktop-stage">
            <section class="fullscreen-cover-column" aria-label="当前歌曲">
              <div class="fullscreen-cover-frame">
                <img v-if="cover" :key="coverEpoch" class="fullscreen-cover" :src="cover" :alt="state.player.current_song?.title || '歌曲封面'" @error="onCoverError" @load="onCoverLoad" />
                <div v-else class="fullscreen-cover player-cover-empty"><SlIcon name="music_note" :size="44" player-icon /></div>
              </div>
              <div class="fullscreen-song-meta fullscreen-song-meta-desktop">
                <span class="fullscreen-song-title">{{ state.player.current_song?.title || '暂无播放' }}</span>
                <span class="fullscreen-song-artist">{{ state.player.current_song?.artist || '选择一首歌曲开始播放' }}</span>
              </div>
            </section>
            <section ref="desktopLyrics" class="lyrics fullscreen-lyrics-panel" aria-label="歌词">
              <template v-if="lyrics.length">
                <div v-for="(line, index) in lyrics" :key="`${line.time}-${index}`" class="lyric-line" :class="{ active: index === activeLyric }">{{ line.text }}</div>
              </template>
              <div v-else class="lyrics-empty">暂无歌词</div>
            </section>
          </div>

          <div class="fullscreen-mobile-stage">
            <div
              ref="mobilePager"
              class="fullscreen-mobile-pager"
              @scroll.passive="syncMobilePage"
              @touchstart.passive="startMobileSwipe"
              @touchend="finishMobileSwipe"
            >
              <section class="fullscreen-mobile-slide" aria-label="歌曲封面">
                <div class="fullscreen-cover-frame">
                  <img v-if="coverMobile" :key="coverMobileEpoch" class="fullscreen-cover" :src="coverMobile" :alt="state.player.current_song?.title || '歌曲封面'" @error="onCoverMobileError" @load="onCoverMobileLoad" />
                  <div v-else class="fullscreen-cover player-cover-empty"><SlIcon name="music_note" :size="44" player-icon /></div>
                </div>
              </section>
              <section ref="mobileLyrics" class="fullscreen-mobile-slide lyrics fullscreen-lyrics-panel" aria-label="歌词">
                <template v-if="lyrics.length">
                  <div v-for="(line, index) in lyrics" :key="`${line.time}-${index}`" class="lyric-line" :class="{ active: index === activeLyric }">{{ line.text }}</div>
                </template>
                <div v-else class="lyrics-empty">暂无歌词</div>
              </section>
            </div>
            <div class="fullscreen-page-indicator" aria-label="播放器页面">
              <button type="button" :class="{ active: mobilePage === 0 }" aria-label="显示封面" @click="showMobilePage(0)"></button>
              <button type="button" :class="{ active: mobilePage === 1 }" aria-label="显示歌词" @click="showMobilePage(1)"></button>
            </div>
          </div>
        </div>

        <div class="fullscreen-playback">
          <div class="fullscreen-song-meta fullscreen-song-meta-mobile">
            <span class="fullscreen-song-title">{{ state.player.current_song?.title || '暂无播放' }}</span>
            <span class="fullscreen-song-artist">{{ state.player.current_song?.artist || '选择一首歌曲开始播放' }}</span>
          </div>
          <PlayerProgress
            :position="Number(state.player.position || 0)"
            :duration="Number(state.player.duration || 0)"
            :disabled="state.playerBusy"
            @seek="seekPlayer"
          />

          <div class="fullscreen-controls fullscreen-controls-desktop">
            <SlButton variant="icon" icon="skip_previous" player-icon :icon-size="26" class="player-control-button" title="上一首" :disabled="state.playerBusy" @click="playerCommand('/player/previous')" />
            <SlButton
              class="control-primary"
              variant="filled"
              player-icon
              :icon-size="32"
              :icon="state.player.is_playing ? 'pause' : 'play_arrow'"
              :title="state.player.is_playing ? '暂停' : '播放'"
              :disabled="state.playerBusy"
              @click="playerCommand('/player/toggle')"
            />
            <SlButton variant="icon" icon="skip_next" player-icon :icon-size="26" class="player-control-button" title="下一首" :disabled="state.playerBusy" @click="playerCommand('/player/next')" />
          </div>

          <div class="fullscreen-controls fullscreen-controls-mobile">
            <PlayerModePopup
              :model-value="state.player.play_mode || 'order'"
              popup-id="full-mode"
              :disabled="state.playerBusy"
              @change="setPlayMode"
            />
            <SlButton variant="icon" icon="skip_previous" player-icon :icon-size="38" class="player-control-button" title="上一首" :disabled="state.playerBusy" @click="playerCommand('/player/previous')" />
            <SlButton
              class="control-primary"
              variant="filled"
              player-icon
              :icon-size="46"
              :icon="state.player.is_playing ? 'pause' : 'play_arrow'"
              :title="state.player.is_playing ? '暂停' : '播放'"
              :disabled="state.playerBusy"
              @click="playerCommand('/player/toggle')"
            />
            <SlButton variant="icon" icon="skip_next" player-icon :icon-size="38" class="player-control-button" title="下一首" :disabled="state.playerBusy" @click="playerCommand('/player/next')" />
            <SlButton
              class="player-favorite-button"
              variant="icon"
              player-icon
              :icon="isFavorite ? 'favorite' : 'favorite_border'"
              :title="isFavorite ? '取消收藏' : '收藏'"
              :class="{ 'player-control-active': isFavorite }"
              :disabled="favoriteBusy || !state.player.current_song"
              @click="toggleFavorite"
            />
          </div>

          <div class="fullscreen-tools">
            <SlButton
              class="fullscreen-tool-desktop player-favorite-button"
              variant="icon"
              player-icon
              :icon="isFavorite ? 'favorite' : 'favorite_border'"
              :title="isFavorite ? '取消收藏' : '收藏'"
              :class="{ 'player-control-active': isFavorite }"
              :disabled="favoriteBusy || !state.player.current_song"
              @click="toggleFavorite"
            />
            <PlayerModePopup
              class="fullscreen-tool-desktop"
              :model-value="state.player.play_mode || 'order'"
              popup-id="full-mode-desktop"
              :disabled="state.playerBusy"
              @change="setPlayMode"
            />
            <PlayerSpeedPopup
              :model-value="Number(state.player.speed || 1)"
              popup-id="full-speed"
              :disabled="state.playerBusy"
              @change="setPlaybackSpeed"
            />
            <PlayerVolumePopup
              :model-value="Number(state.player.volume || 0)"
              popup-id="full-volume"
              :disabled="state.playerBusy"
              @change="setVolume"
            />
            <PlayerSleepTimerPopup
              :status="sleepTimer"
              popup-id="full-sleep-timer"
              :disabled="!state.currentAccountId || !state.currentDeviceId"
              :busy="sleepTimerBusy"
              :is-live="!!state.player.current_song?.is_live"
              @refresh="loadSleepTimer"
              @set="setSleepTimer"
              @cancel="cancelSleepTimer"
            />
            <SlButton variant="icon" icon="stop" player-icon class="player-tool-button" title="停止播放" :disabled="state.playerBusy" @click="playerCommand('/player/stop')" />
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
