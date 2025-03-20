# GraphQL Cluster Visualizer Chrome Extension

A Chrome extension that intercepts GraphQL requests and visualizes cluster data directly in the webpage.

## Features

- Intercepts GraphQL requests and responses
- Automatically detects cluster data in GraphQL responses
- Visualizes clusters as interactive graphs directly in the webpage
- Supports both Fetch API and XMLHttpRequest
- Provides a popup UI to show cluster information and control the visualizer
- Keyboard shortcut (Ctrl+Shift+C) to toggle the visualizer

## Installation

### From Source

1. Clone this repository or download the source code
2. Run `npm install` to install dependencies
3. Run `npm run download-deps` to download required libraries (D3.js, etc.)
4. Run `npm run build` to build the extension
5. Open Chrome and navigate to `chrome://extensions/`
6. Enable "Developer mode" in the top right corner
7. Click "Load unpacked" and select the `dist` directory

## Usage

1. Navigate to a website that makes GraphQL requests containing cluster data
2. The extension will automatically intercept these requests
3. When cluster data is detected, the extension icon will become active
4. Click the extension icon to see information about the detected cluster
5. Click "Show Visualizer" to display the cluster visualization on the webpage
6. Use the visualizer UI to interact with the cluster graph:
   - Drag nodes to reposition them
   - Zoom in/out using the mouse wheel
   - Pan the graph by clicking and dragging the background
   - Enter a specific cluster ID to visualize it

## Development

- `npm run watch` - Watch for changes and rebuild automatically
- `npm run zip` - Create a ZIP file for distribution

## Technologies Used

- JavaScript
- Chrome Extension API
- D3.js for visualization
- GraphQL

## License

MIT