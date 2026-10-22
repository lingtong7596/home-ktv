import { execFile } from 'node:child_process';

/**
 * 读取视频的时长、画面和音轨信息。
 * 双音轨 KTV 文件的音轨顺序通常是：第1条=原唱，第2条=伴唱。
 */
export function ffprobe(file, ffprobePath = 'ffprobe', timeout = 45000) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 16 * 1024 * 1024, timeout },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const data = JSON.parse(stdout);
          resolve(normalize(data));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function normalize(data) {
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audios = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, i) => ({
      i,
      codec: s.codec_name || '',
      channels: s.channels || 0,
      lang: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
      title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
      bitrate: Number(s.bit_rate || 0),
    }));
  return {
    duration: Number(data.format && data.format.duration) || (video && Number(video.duration)) || 0,
    width: video ? Number(video.width) || 0 : 0,
    height: video ? Number(video.height) || 0 : 0,
    vcodec: video ? video.codec_name || '' : '',
    audios,
  };
}

export function ffmpegAvailable(ffmpegPath = 'ffmpeg') {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-version'], { timeout: 8000 }, (err) => resolve(!err));
  });
}
