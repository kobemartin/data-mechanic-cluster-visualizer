// Popup script for GraphQL Cluster Visualizer Extension

document.addEventListener('DOMContentLoaded', function() {
  const statusElement = document.getElementById('status');
  const toggleVisualizerButton = document.getElementById('toggle-visualizer');
  const clearDataButton = document.getElementById('clear-data');
  const clusterInfoElement = document.getElementById('cluster-info');
  const clusterIdElement = document.getElementById('cluster-id');
  const nodeCountElement = document.getElementById('node-count');
  const edgeCountElement = document.getElementById('edge-count');
  
  console.log('Popup loaded, checking for cluster data');
  
  // Check if we have any captured cluster data
  chrome.runtime.sendMessage({ action: 'getLastClusterData' }, function(response) {
    console.log('Received response from background script:', response);
    
    if (response && response.lastClusterData) {
      const clusterData = response.lastClusterData;
      console.log('Found cluster data:', clusterData);
      
      // Update status
      statusElement.textContent = 'GraphQL cluster data detected';
      statusElement.className = 'status active';
      
      // Show cluster info
      clusterInfoElement.style.display = 'block';
      clusterIdElement.textContent = clusterData.id;
      nodeCountElement.textContent = clusterData.nodes.length;
      edgeCountElement.textContent = clusterData.edges.length;
    } else {
      console.log('No cluster data found');
      
      // No cluster data yet
      statusElement.textContent = 'No GraphQL cluster data detected. Click "Show Visualizer" to load sample data.';
      statusElement.className = 'status inactive';
      clusterInfoElement.style.display = 'none';
    }
  });
  
  // Toggle visualizer button
  toggleVisualizerButton.addEventListener('click', function() {
    console.log('Toggle visualizer button clicked');
    
    // Get the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0]) {
        console.log('Sending toggleVisualizer message to tab:', tabs[0].id);
        
        // Send message to content script to toggle visualizer
        chrome.tabs.sendMessage(
          tabs[0].id,
          { action: 'toggleVisualizer' },
          function(response) {
            console.log('Received response from content script:', response);
            
            // Close popup
            window.close();
          }
        );
      } else {
        console.error('No active tab found');
      }
    });
  });
  
  // Clear data button
  clearDataButton.addEventListener('click', function() {
    chrome.runtime.sendMessage({ action: 'clearData' }, function() {
      statusElement.textContent = 'Data cleared. Waiting for new GraphQL requests...';
      statusElement.className = 'status inactive';
      clusterInfoElement.style.display = 'none';
    });
  });
});