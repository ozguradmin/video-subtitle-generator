# Video Subtitle Generator

AI-powered video subtitle generator with modern mobile-first UI built with Alpine.js and Tailwind CSS.

## Features

- 🤖 **AI-Powered Subtitle Generation** using Google Gemini 2.5 Pro
- 📱 **Modern Mobile-First UI** with Alpine.js and Tailwind CSS
- ✏️ **Real-time Subtitle Editing** with undo/redo functionality
- 🎨 **Individual Speaker Color Customization**
- 📐 **Video Resizing** to 9:16 aspect ratio with black padding
- 🔤 **Font Customization** and italic text support
- 📊 **Real-time Log Monitoring** during processing
- 💾 **Download Processed Videos** with proper naming

## Tech Stack

- **Backend**: Node.js + Express
- **AI**: Google Generative AI (Gemini 2.5 Pro)
- **Video Processing**: FFmpeg
- **Frontend**: Alpine.js + Tailwind CSS
- **Deployment**: Netlify Functions

## Installation

1. Clone the repository:
```bash
git clone https://github.com/ozguradmin/video-subtitle-generator.git
cd video-subtitle-generator
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file and add your Google AI API key:
```env
GEMINI_API_KEY=your_api_key_here
```

4. Start the development server:
```bash
npm run dev
```

## Usage

1. Open your browser and go to `http://localhost:4000`
2. Upload a video file
3. Wait for AI to generate subtitles
4. Edit subtitles in real-time
5. Customize colors, fonts, and positioning
6. Download the processed video

## API Endpoints

- `POST /upload` - Upload video and generate subtitles
- `POST /reprocess` - Reprocess video with new settings
- `GET /processed/*` - Download processed videos

## Environment Variables

- `GEMINI_API_KEY` - Your Google AI API key
- `PORT` - Server port (default: 4000)

## Deployment

### Netlify

1. Connect your GitHub repository to Netlify
2. Set build command: `npm install`
3. Set publish directory: `public`
4. Add environment variable: `GEMINI_API_KEY`

### Other Platforms

This project can also be deployed to:
- Vercel
- Railway
- Heroku
- DigitalOcean App Platform

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

If you encounter any issues, please open an issue on GitHub.
