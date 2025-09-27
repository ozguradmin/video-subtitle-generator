try {
  require('@ffmpeg-installer/ffmpeg');
  require('@ffprobe-installer/ffprobe');
  console.log('FFmpeg and FFprobe binaries are prepared for Vercel.');
} catch (e) {
  console.error('Error pre-requiring ffmpeg/ffprobe during build:', e);
  process.exit(1);
}
