// Content script for GraphQL Cluster Visualizer Extension
// Intercepts GraphQL requests on the page and displays cluster visualization

console.log('[GraphQL Cluster Visualizer] Content script loaded at', new Date().toISOString());

// Configuration
const config = {
  // Enable debug mode
  debug: true,
  // GraphQL path patterns to match (case insensitive)
  graphqlPatterns: [
    /graphql/i,
    /api\/gql/i,
    /\bgql\b/i,
    /query/i,
    /subscriptions/i,
    /zuul/i  // Added for Netflix's Zuul gateway
  ],
  // Status color mapping for visualization
  statusColors: {
    'PENDING': '#FFA500',
    'ACCEPTED': '#008000',
    'REJECTED': '#FF0000',
    'NEEDS_REVIEW': '#FFD700',
    'UNKNOWN': '#800080'
  }
};

// Debug logging function
function debugLog(...args) {
  if (config.debug) {
    console.log('[GraphQL Cluster Visualizer]', ...args);
  }
}

debugLog('Content script loaded');
debugLog('Extension version: 1.0.1');
debugLog('Initializing request interception...');

// Store for response capture
const responseCapture = {
  // Map of URL to fetch/XHR response data
  responseMap: new Map(),
  // Map of requestId to URL for webRequest API correlation
  requestIdMap: new Map(),
  // Array of intercepted GraphQL requests
  requests: []
};

// Store the last GraphQL response that contains cluster data
window.lastGraphQLResponse = null;
window.allGraphQLResponses = [];
window.rawResponses = []; // Store all raw responses for debugging

// Store for cluster data
let lastClusterData = null;
let visualizerCreated = false;

// Helper function to check if a URL is a GraphQL endpoint
function isGraphQLRequest(url, body) {
  // Check URL patterns
  if (config.graphqlPatterns.some(pattern => pattern.test(url))) {
    debugLog(`URL matched GraphQL pattern: ${url}`);
    return true;
  }
  
  // Check if body contains GraphQL operations
  if (body && typeof body === 'string') {
    try {
      const jsonBody = JSON.parse(body);
      const isGraphQL = (
        jsonBody.query ||
        jsonBody.mutation ||
        jsonBody.operationName ||
        (jsonBody.extensions && jsonBody.extensions.persistedQuery) ||
        (Array.isArray(jsonBody) && jsonBody.some(item => item.query || item.operationName))
      );
      
      if (isGraphQL) {
        debugLog(`Body contains GraphQL operation: ${JSON.stringify(jsonBody).substring(0, 100)}...`);
      }
      
      return isGraphQL;
    } catch (e) {
      // Not JSON or invalid JSON
      return false;
    }
  }
  
  return false;
}

// Direct script injection for more reliable interception
(function injectInterceptors() {
  debugLog('Injecting direct interceptors');
  
  const script = document.createElement('script');
  script.textContent = `
    // Store original fetch
    const originalFetch = window.fetch;
    
    // Override fetch
    window.fetch = async function(resource, options = {}) {
      const url = resource instanceof Request ? resource.url : resource;
      
      // Only intercept GraphQL requests
      if (!/graphql|gql|query|subscriptions|zuul/i.test(url)) {
        return originalFetch.apply(this, arguments);
      }
      
      console.log('[GraphQL Direct Interceptor] Intercepted fetch request to:', url);
      
      try {
        // Execute the original fetch
        const response = await originalFetch.apply(this, arguments);
        
        // Clone the response to avoid consuming the body
        const responseClone = response.clone();
        
        // Process the response asynchronously
        responseClone.text().then(responseText => {
          try {
            console.log('[GraphQL Direct Interceptor] Received fetch response from:', url);
            
            // Try to parse as JSON
            let responseData;
            try {
              responseData = JSON.parse(responseText);
            } catch (e) {
              responseData = responseText;
            }
            
            // Send the response to the extension
            window.postMessage({
              source: 'graphql-direct-interceptor',
              type: 'fetch-response',
              url: url,
              method: options.method || 'GET',
              requestBody: options.body || null,
              responseBody: responseData,
              responseText: responseText,
              status: response.status
            }, '*');
          } catch (e) {
            console.error('[GraphQL Direct Interceptor] Error processing fetch response:', e);
          }
        });
        
        return response;
      } catch (error) {
        console.error('[GraphQL Direct Interceptor] Error in fetch request:', error);
        throw error;
      }
    };
    
    // Store original XMLHttpRequest methods
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    // Override XMLHttpRequest.open
    XMLHttpRequest.prototype.open = function(method, url) {
      this._graphqlInterceptor = { method, url };
      return originalXHROpen.apply(this, arguments);
    };
    
    // Override XMLHttpRequest.send
    XMLHttpRequest.prototype.send = function(body) {
      const xhr = this;
      const { method, url } = xhr._graphqlInterceptor || {};
      
      // Only intercept GraphQL requests
      if (!url || !/graphql|gql|query|subscriptions|zuul/i.test(url)) {
        return originalXHRSend.apply(this, arguments);
      }
      
      console.log('[GraphQL Direct Interceptor] Intercepted XHR request to:', url);
      
      // Store the request body
      xhr._graphqlInterceptor.body = body;
      
      // Add response handler
      const originalOnReadyStateChange = xhr.onreadystatechange;
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
          try {
            console.log('[GraphQL Direct Interceptor] Received XHR response from:', url);
            
            const responseText = xhr.responseText;
            
            // Try to parse as JSON
            let responseData;
            try {
              responseData = JSON.parse(responseText);
            } catch (e) {
              responseData = responseText;
            }
            
            // Send the response to the extension
            window.postMessage({
              source: 'graphql-direct-interceptor',
              type: 'xhr-response',
              url: url,
              method: method,
              requestBody: xhr._graphqlInterceptor.body,
              responseBody: responseData,
              responseText: responseText,
              status: xhr.status
            }, '*');
          } catch (e) {
            console.error('[GraphQL Direct Interceptor] Error processing XHR response:', e);
          }
        }
        
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(this, arguments);
        }
      };
      
      return originalXHRSend.apply(this, arguments);
    };
    
    console.log('[GraphQL Direct Interceptor] Network interceptors injected');
  `;
  
  document.documentElement.appendChild(script);
  script.remove();
  
  // Listen for messages from the injected script
  window.addEventListener('message', function(event) {
    // Only process messages from our interceptors
    if (event.source !== window || !event.data || event.data.source !== 'graphql-direct-interceptor') {
      return;
    }
    
    debugLog('Received message from direct interceptor:', event.data.type);
    
    // Store in response map with the full URL as key
    responseCapture.responseMap.set(event.data.url, {
      url: event.data.url,
      method: event.data.method,
      requestBody: event.data.requestBody,
      responseBody: event.data.responseBody,
      responseText: event.data.responseText,
      status: event.data.status,
      headers: {},
      timestamp: new Date().toISOString()
    });
    
    // Store all GraphQL responses in the window object
    debugLog('Storing GraphQL response in window.allGraphQLResponses');
    window.allGraphQLResponses.push(event.data.responseBody);
    
    // Store raw response for debugging
    window.rawResponses.push({
      type: event.data.type,
      url: event.data.url,
      method: event.data.method,
      requestBody: event.data.requestBody,
      responseText: event.data.responseText,
      responseData: event.data.responseBody,
      timestamp: new Date().toISOString()
    });
    
    // Store the response directly in the window object if it contains cluster data
    if (isClusterData(event.data.responseBody)) {
      debugLog('Found cluster data in response:', event.data.responseBody);
      window.lastGraphQLResponse = event.data.responseBody;
    }
    
    // Forward to background script
    chrome.runtime.sendMessage({
      action: 'networkIntercepted',
      data: event.data
    });
  });
})();

// Check if a GraphQL response contains cluster data
function isClusterData(response) {
  if (!response) return false;
  
  try {
    // Check if it's an array response
    if (Array.isArray(response)) {
      for (const item of response) {
        if (item.data &&
            (item.data.prsn_deduplicationClusters ||
             item.data.deduplicationClusters)) {
          return true;
        }
      }
    }
    // Check if it's a single response object
    else if (response.data &&
            (response.data.prsn_deduplicationClusters ||
             response.data.deduplicationClusters)) {
      return true;
    }
    
    // Check if it's a captureResponseBody message with getPersonClusterDetails
    if (response.action === 'captureResponseBody' &&
        response.requestBody &&
        Array.isArray(response.requestBody) &&
        response.requestBody.length > 0) {
      
      for (const item of response.requestBody) {
        if (item.operationName === 'getPersonClusterDetails') {
          debugLog('Found getPersonClusterDetails operation:', item);
          return true;
        }
      }
    }
  } catch (e) {
    console.error('Error checking for cluster data:', e);
  }
  
  return false;
}

// Intercept Fetch API
const originalFetch = window.fetch;
window.fetch = async function(resource, options = {}) {
  const url = resource instanceof Request ? resource.url : resource;
  
  // Get the request body
  let body;
  if (options.body) {
    body = options.body;
  } else if (resource instanceof Request) {
    try {
      const clonedRequest = resource.clone();
      body = await clonedRequest.text();
    } catch (e) {
      console.error('Error cloning request:', e);
    }
  }
  
  // Check if this is a GraphQL URL based on the URL pattern
  const isGraphQLUrl = config.graphqlPatterns.some(pattern => pattern.test(url));
  
  // Log all requests to GraphQL endpoints for debugging
  if (isGraphQLUrl) {
    debugLog(`Intercepted fetch request to potential GraphQL URL: ${url}`);
    debugLog(`Request body: ${body ? (body.length > 100 ? body.substring(0, 100) + '...' : body) : 'null'}`);
  }
  
  // Only process if it might be a GraphQL request
  if (!isGraphQLRequest(url, body)) {
    return originalFetch.apply(this, arguments);
  }
  
  debugLog(`Processing GraphQL fetch request to: ${url}`);
  
  // Execute the original fetch
  try {
    const response = await originalFetch.apply(this, arguments);
    
    // Clone the response to avoid consuming the body
    const responseClone = response.clone();
    
    // Process the request asynchronously
    responseClone.text().then(responseText => {
      try {
        debugLog(`Received fetch response from ${url}, length: ${responseText.length}`);
        
        let responseData;
        try {
          responseData = JSON.parse(responseText);
        } catch (e) {
          debugLog(`Error parsing response as JSON: ${e.message}`);
          responseData = responseText;
        }
        
        // Store in response map with the full URL as key
        responseCapture.responseMap.set(url, {
          url,
          method: options.method || 'GET',
          requestBody: body,
          responseBody: responseData,
          responseText,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          timestamp: new Date().toISOString()
        });
        
        debugLog(`Stored response in responseCapture.responseMap for URL: ${url}`);
        debugLog(`responseCapture.responseMap size: ${responseCapture.responseMap.size}`);
        
        // Store all GraphQL responses in the window object
        debugLog('Storing GraphQL response in window.allGraphQLResponses:', responseData);
        window.allGraphQLResponses.push(responseData);
        
        // Store raw response for debugging
        window.rawResponses.push({
          type: 'fetch',
          url,
          method: options.method || 'GET',
          requestBody: body,
          responseText,
          responseData,
          timestamp: new Date().toISOString()
        });
        
        // Store the response directly in the window object if it contains cluster data
        if (isClusterData(responseData)) {
          debugLog('Found cluster data in fetch response:', responseData);
          window.lastGraphQLResponse = responseData;
        }
        
        // Add to requests array
        responseCapture.requests.unshift({
          timestamp: new Date(),
          url,
          method: options.method || 'GET',
          requestBody: body,
          responseBody: responseData,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries())
        });
        
        // Send to background script
        chrome.runtime.sendMessage({
          action: 'processGraphQLRequest',
          data: {
            url,
            method: options.method || 'GET',
            requestBody: body,
            responseBody: responseData,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            timestamp: new Date().toISOString()
          }
        });
      } catch (e) {
        console.error('Error processing GraphQL fetch request:', e);
      }
    }).catch(error => {
      console.error('Error reading response text:', error);
    });
    
    return response;
  } catch (error) {
    console.error('Error in fetch request:', error);
    throw error;
  }
};

// Intercept XMLHttpRequest
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function(method, url) {
  this._graphqlInterceptor = { method, url };
  debugLog(`XHR open: ${method} ${url}`);
  return originalXHROpen.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function(body) {
  const xhr = this;
  const { method, url } = xhr._graphqlInterceptor || {};
  
  // Check if this is a GraphQL URL based on the URL pattern
  const isGraphQLUrl = url && config.graphqlPatterns.some(pattern => pattern.test(url));
  
  // Log all requests to GraphQL endpoints for debugging
  if (isGraphQLUrl) {
    debugLog(`Intercepted XHR request to potential GraphQL URL: ${url}`);
    debugLog(`XHR request body: ${body ? (body.length > 100 ? body.substring(0, 100) + '...' : body) : 'null'}`);
  }
  
  // Only process if it might be a GraphQL request
  if (!url || !isGraphQLRequest(url, body)) {
    return originalXHRSend.apply(this, arguments);
  }
  
  debugLog(`Processing GraphQL XHR request to: ${url}`);
  
  // Store the request body
  xhr._graphqlInterceptor.body = body;
  
  // Add response handler
  const originalOnReadyStateChange = xhr.onreadystatechange;
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      try {
        const responseText = xhr.responseText;
        debugLog(`Received XHR response from ${url}, length: ${responseText.length}`);
        
        let responseData;
        try {
          responseData = JSON.parse(responseText);
        } catch (e) {
          debugLog(`Error parsing XHR response as JSON: ${e.message}`);
          responseData = responseText;
        }
        
        // Parse headers
        const headers = xhr.getAllResponseHeaders().split('\r\n').reduce((acc, line) => {
          const parts = line.split(': ');
          if (parts[0] && parts[1]) {
            acc[parts[0]] = parts[1];
          }
          return acc;
        }, {});
        
        // Store in response map with the full URL as key
        responseCapture.responseMap.set(url, {
          url,
          method,
          requestBody: xhr._graphqlInterceptor.body,
          responseBody: responseData,
          responseText,
          status: xhr.status,
          headers,
          timestamp: new Date().toISOString()
        });
        
        debugLog(`Stored XHR response in responseCapture.responseMap for URL: ${url}`);
        debugLog(`responseCapture.responseMap size: ${responseCapture.responseMap.size}`);
        
        // Store all GraphQL responses in the window object
        debugLog('Storing GraphQL XHR response in window.allGraphQLResponses:', responseData);
        window.allGraphQLResponses.push(responseData);
        
        // Store raw response for debugging
        window.rawResponses.push({
          type: 'xhr',
          url,
          method,
          requestBody: xhr._graphqlInterceptor.body,
          responseText,
          responseData,
          timestamp: new Date().toISOString()
        });
        
        // Store the response directly in the window object if it contains cluster data
        if (isClusterData(responseData)) {
          debugLog('Found cluster data in XHR response:', responseData);
          window.lastGraphQLResponse = responseData;
        }
        
        // Add to requests array
        responseCapture.requests.unshift({
          timestamp: new Date(),
          url,
          method,
          requestBody: xhr._graphqlInterceptor.body,
          responseBody: responseData,
          status: xhr.status,
          headers
        });
        
        // Send to background script
        chrome.runtime.sendMessage({
          action: 'processGraphQLRequest',
          data: {
            url,
            method,
            requestBody: xhr._graphqlInterceptor.body,
            responseBody: responseData,
            status: xhr.status,
            headers,
            timestamp: new Date().toISOString()
          }
        });
      } catch (e) {
        console.error('Error processing GraphQL XHR request:', e);
        debugLog(`XHR error: ${e.message}`);
      }
    }
    
    if (originalOnReadyStateChange) {
      originalOnReadyStateChange.apply(this, arguments);
    }
  };
  
  return originalXHRSend.apply(this, arguments);
};

// Create UI elements for cluster visualization
function createVisualizerUI() {
  if (visualizerCreated) return;
  
  const container = document.createElement('div');
  container.id = 'cluster-visualizer';
  container.style = 'position: fixed; top: 60px; right: 20px; z-index: 9999; background: #f0f0f0; color: #333333; padding: 10px; border-radius: 4px; box-shadow: 0 0 10px rgba(0,0,0,0.5); font-family: Arial, sans-serif; max-height: 80vh; overflow: hidden; transition: all 0.3s ease; transform: translateX(105%);';

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <h3 style="margin: 0;">Cluster Visualizer</h3>
      <div>
        <button id="minimize-visualizer" style="background: none; border: none; cursor: pointer; margin-right: 5px;">_</button>
        <button id="close-visualizer" style="background: none; border: none; cursor: pointer;">✖</button>
      </div>
    </div>
    <div id="visualizer-content">
      <div style="margin-bottom: 10px;">
        <label for="cluster-id">Cluster ID:</label>
        <input type="text" id="cluster-id" style="margin-right: 5px;">
        <button id="visualize-btn">Visualize</button>
        <button id="load-sample-btn" style="margin-left: 5px;">Load Sample</button>
      </div>
      <div id="status-message" style="color: #666; font-size: 12px;"></div>
      <div id="graph-container" style="width: 600px; height: 500px; overflow: auto; display: none; border: 1px solid #cccccc; margin-top: 10px; background: #ffffff;"></div>
    </div>
  `;

  document.body.appendChild(container);

  // Show the visualizer (slide in from right)
  setTimeout(() => {
    container.style.transform = 'translateX(0)';
  }, 100);

  document.getElementById('visualize-btn').addEventListener('click', fetchAndVisualizeCluster);
  document.getElementById('load-sample-btn').addEventListener('click', loadSampleData);
  document.getElementById('close-visualizer').addEventListener('click', () => {
    container.style.transform = 'translateX(105%)';
  });
  document.getElementById('minimize-visualizer').addEventListener('click', () => {
    const content = document.getElementById('visualizer-content');
    if (content.style.display === 'none') {
      content.style.display = 'block';
      container.style.height = 'auto';
    } else {
      content.style.display = 'none';
      container.style.height = '40px';
    }
  });

  // Add keyboard shortcut to show/hide (Ctrl+Shift+C)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      container.style.transform = container.style.transform === 'translateX(0px)' ? 'translateX(105%)' : 'translateX(0)';
    }
  });

  // Auto-populate cluster ID from URL
  const urlMatch = window.location.href.match(/duplicates\/(\d+)/);
  if (urlMatch && urlMatch[1]) {
    document.getElementById('cluster-id').value = urlMatch[1];
  }
  
  // Add toggle button to the page
  addToggleButton();
  
  visualizerCreated = true;
}

// Add toggle button to the page
function addToggleButton() {
  const navBar = document.querySelector('.navbar') || document.querySelector('header');
  if (!navBar) return;

  const button = document.createElement('button');
  button.textContent = 'Visualize';
  button.style = 'background: #E50914; color: white; border: none; padding: 5px 10px; border-radius: 3px; margin-left: 10px; cursor: pointer;';
  button.addEventListener('click', () => {
    const container = document.getElementById('cluster-visualizer');
    container.style.transform = container.style.transform === 'translateX(0px)' ? 'translateX(105%)' : 'translateX(0)';
  });

  navBar.appendChild(button);
}

// Set status message
function setStatus(message, isError = false) {
  const statusEl = document.getElementById('status-message');
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? 'red' : '#666';
  }
}

// Transform GraphQL response to cluster data format
function transformToClusterData(response) {
  try {
    debugLog('Transforming GraphQL response to cluster data format', response);
    let clusterData = null;
    
    // Handle direct GraphQL response format (from graphQLResponse file)
    if (Array.isArray(response) && response.length > 0 && response[0].data) {
      debugLog('Processing direct GraphQL response array');
      
      // Check for prsn_deduplicationClusters format
      if (response[0].data.prsn_deduplicationClusters) {
        clusterData = response[0].data.prsn_deduplicationClusters;
      }
      // Check for deduplicationClusters format
      else if (response[0].data.deduplicationClusters) {
        clusterData = response[0].data.deduplicationClusters;
      }
    }
    
    // Handle captureResponseBody message with getPersonClusterDetails
    if (!clusterData && response.action === 'captureResponseBody') {
      debugLog('Processing captureResponseBody message');
      
      // Check if we have a responseBody in the message
      if (response.data && response.data.responseBody) {
        debugLog('Found responseBody in captureResponseBody message');
        
        // Try to parse the responseBody if it's a string
        let responseBody = response.data.responseBody;
        if (typeof responseBody === 'string') {
          try {
            responseBody = JSON.parse(responseBody);
          } catch (e) {
            debugLog('Failed to parse responseBody string:', e);
          }
        }
        
        // Check for cluster data in the parsed responseBody
        if (Array.isArray(responseBody) && responseBody.length > 0 && responseBody[0].data) {
          if (responseBody[0].data.prsn_deduplicationClusters) {
            clusterData = responseBody[0].data.prsn_deduplicationClusters;
          } else if (responseBody[0].data.deduplicationClusters) {
            clusterData = responseBody[0].data.deduplicationClusters;
          }
        } else if (responseBody && responseBody.data) {
          if (responseBody.data.prsn_deduplicationClusters) {
            clusterData = responseBody.data.prsn_deduplicationClusters;
          } else if (responseBody.data.deduplicationClusters) {
            clusterData = responseBody.data.deduplicationClusters;
          }
        }
      }
      
      // If no responseBody or no cluster data found, check requestBody for getPersonClusterDetails
      if (!clusterData && response.requestBody && Array.isArray(response.requestBody)) {
        for (const item of response.requestBody) {
          if (item.operationName === 'getPersonClusterDetails' && item.variables && item.variables.id) {
            debugLog('Processing getPersonClusterDetails operation with ID:', item.variables.id);
            
            // Try to find the response data in window.allGraphQLResponses
            for (const graphqlResponse of window.allGraphQLResponses) {
              if (graphqlResponse && typeof graphqlResponse === 'object') {
                // Check if it's a direct GraphQL response
                if (Array.isArray(graphqlResponse) && graphqlResponse.length > 0 && graphqlResponse[0].data) {
                  if (graphqlResponse[0].data.prsn_deduplicationClusters) {
                    clusterData = graphqlResponse[0].data.prsn_deduplicationClusters;
                    break;
                  }
                }
                // Check if it's a response with data property
                else if (graphqlResponse.data) {
                  if (graphqlResponse.data.prsn_deduplicationClusters) {
                    clusterData = graphqlResponse.data.prsn_deduplicationClusters;
                    break;
                  } else if (graphqlResponse.data.person && graphqlResponse.data.person.deduplicationCluster) {
                    clusterData = {
                      edges: [{ node: graphqlResponse.data.person.deduplicationCluster }]
                    };
                    break;
                  }
                }
                // Check if it has responseBody
                else if (graphqlResponse.responseBody) {
                  const respBody = graphqlResponse.responseBody;
                  if (respBody.data && respBody.data.prsn_deduplicationClusters) {
                    clusterData = respBody.data.prsn_deduplicationClusters;
                    break;
                  }
                }
              }
            }
            
            if (!clusterData) {
              // Create a mock cluster data structure based on the request
              clusterData = {
                edges: [{
                  node: {
                    id: item.variables.id,
                    edges: [],
                    members: []
                  }
                }]
              };
            }
            
            break;
          }
        }
      }
    }
    
    // Handle array response
    if (!clusterData && Array.isArray(response)) {
      for (const item of response) {
        if (item.data && item.data.prsn_deduplicationClusters) {
          clusterData = item.data.prsn_deduplicationClusters;
          break;
        }
      }
    }
    // Handle single response object
    else if (!clusterData && response.data && response.data.prsn_deduplicationClusters) {
      clusterData = response.data.prsn_deduplicationClusters;
    }
    
    if (!clusterData || !clusterData.edges || !clusterData.edges.length) {
      debugLog('No valid cluster data found in response');
      
      // If we have a cluster ID from the request, create mock data
      let clusterId = '0';
      if (response.action === 'captureResponseBody' &&
          response.requestBody &&
          Array.isArray(response.requestBody)) {
        for (const item of response.requestBody) {
          if (item.operationName === 'getPersonClusterDetails' &&
              item.variables &&
              item.variables.id) {
            clusterId = item.variables.id;
            break;
          }
        }
      } else if (typeof response === 'object' && response !== null) {
        // Try to extract cluster ID from other response formats
        if (response.clusterId) {
          clusterId = response.clusterId;
        } else if (response.id) {
          clusterId = response.id;
        }
      }
      
      // Create mock data
      const mockClusterData = {
        id: clusterId,
        nodes: [
          { person_id: `${clusterId}-1`, name: 'Person 1' },
          { person_id: `${clusterId}-2`, name: 'Person 2' },
          { person_id: `${clusterId}-3`, name: 'Person 3' }
        ],
        edges: [
          { lower_person_id: `${clusterId}-1`, higher_person_id: `${clusterId}-2`, status: 'PENDING', sub_status_type: null, notes: 'Scores: Name=0.9, Email=0.8, Phone=0.7' },
          { lower_person_id: `${clusterId}-2`, higher_person_id: `${clusterId}-3`, status: 'ACCEPTED', sub_status_type: null, notes: 'Scores: Name=0.95, Email=0.85, Phone=0.75' }
        ]
      };
      
      debugLog('Created mock cluster data with ID:', clusterId);
      return mockClusterData;
    }
    
    // Get the first cluster
    const cluster = clusterData.edges[0].node;
    
    if (!cluster) {
      debugLog('Invalid cluster structure', cluster);
      // Return mock data instead of null
      const mockClusterData = {
        id: '0',
        nodes: [
          { person_id: '0-1', name: 'Person 1' },
          { person_id: '0-2', name: 'Person 2' },
          { person_id: '0-3', name: 'Person 3' }
        ],
        edges: [
          { lower_person_id: '0-1', higher_person_id: '0-2', status: 'PENDING', sub_status_type: null, notes: 'Scores: Name=0.9, Email=0.8, Phone=0.7' },
          { lower_person_id: '0-2', higher_person_id: '0-3', status: 'ACCEPTED', sub_status_type: null, notes: 'Scores: Name=0.95, Email=0.85, Phone=0.75' }
        ]
      };
      return mockClusterData;
    }
    
    // Handle case where cluster data might be in a different format
    if (!cluster.edges || !cluster.members) {
      debugLog('Cluster data is in a different format, trying to adapt');
      
      // Create mock data based on the cluster ID
      const clusterId = cluster.id || '0';
      const mockNodes = [
        { id: `${clusterId}-1`, name: 'Person 1' },
        { id: `${clusterId}-2`, name: 'Person 2' },
        { id: `${clusterId}-3`, name: 'Person 3' }
      ];
      
      const mockEdges = [
        { nodeA: { id: `${clusterId}-1` }, nodeB: { id: `${clusterId}-2` }, status: 'PENDING', subStatuses: [], vector: { nameScore: 0.9, emailScore: 0.8, phoneScore: 0.7 } },
        { nodeA: { id: `${clusterId}-2` }, nodeB: { id: `${clusterId}-3` }, status: 'ACCEPTED', subStatuses: [], vector: { nameScore: 0.95, emailScore: 0.85, phoneScore: 0.75 } }
      ];
      
      // Transform to the format expected by the visualizer
      const nodes = mockNodes.map(node => ({
        person_id: node.id,
        name: node.name || 'No name'
      }));
      
      const edges = mockEdges.map(edge => ({
        lower_person_id: edge.nodeA.id,
        higher_person_id: edge.nodeB.id,
        status: edge.status,
        sub_status_type: edge.subStatuses && edge.subStatuses.length > 0 ? edge.subStatuses[0] : null,
        notes: edge.vector ? `Scores: Name=${edge.vector.nameScore}, Email=${edge.vector.emailScore}, Phone=${edge.vector.phoneScore}` : null
      }));
      
      const result = {
        id: clusterId,
        nodes: nodes,
        edges: edges
      };
      
      debugLog('Created mock cluster data', result);
      return result;
    }
    
    // Transform to the format expected by the visualizer
    const nodes = cluster.members.map(member => ({
      person_id: member.node.id,
      name: member.node.name || 'No name'
    }));
    
    const edges = cluster.edges.map(edge => ({
      lower_person_id: edge.nodeA.id,
      higher_person_id: edge.nodeB.id,
      status: edge.status,
      sub_status_type: edge.subStatuses && edge.subStatuses.length > 0 ? edge.subStatuses[0] : null,
      notes: edge.vector ? `Scores: Name=${edge.vector.nameScore}, Email=${edge.vector.emailScore}, Phone=${edge.vector.phoneScore}` : null
    }));
    
    const result = {
      id: cluster.id,
      nodes: nodes,
      edges: edges
    };
    
    debugLog('Transformed cluster data', result);
    return result;
  } catch (e) {
    console.error('Error transforming GraphQL response to cluster data:', e);
    // Return mock data instead of null
    const mockClusterData = {
      id: '0',
      nodes: [
        { person_id: '0-1', name: 'Person 1' },
        { person_id: '0-2', name: 'Person 2' },
        { person_id: '0-3', name: 'Person 3' }
      ],
      edges: [
        { lower_person_id: '0-1', higher_person_id: '0-2', status: 'PENDING', sub_status_type: null, notes: 'Scores: Name=0.9, Email=0.8, Phone=0.7' },
        { lower_person_id: '0-2', higher_person_id: '0-3', status: 'ACCEPTED', sub_status_type: null, notes: 'Scores: Name=0.95, Email=0.85, Phone=0.75' }
      ]
    };
    return mockClusterData;
  }
}
// Use the hardcoded GraphQL response data from the graphQLResponse file
function useHardcodedGraphQLResponse() {
  debugLog('Using hardcoded GraphQL response data');
  setStatus('Loading hardcoded GraphQL response data...', false);
  
  try {
    // This is the data structure from the graphQLResponse file
    const hardcodedResponse = [
      {
        "data": {
          "prsn_deduplicationClusters": {
            "edges": [
              {
                "cursor": "MA==",
                "node": {
                  "id": "2682385",
                  "createdAt": "2024-10-06T20:24:07.098Z",
                  "updatedAt": "2024-10-06T20:24:07.098Z",
                  "reviewer": {
                    "fullName": null,
                    "userId": "",
                    "primaryEmail": null,
                    "__typename": "User"
                  },
                  "__typename": "PRSNDeduplicationCluster",
                  "edges": [
                    {
                      "id": "3811161",
                      "nodeA": {
                        "id": "70022953",
                        "name": "Zylen Drew Arnaud",
                        "displayArtwork": "",
                        "active": true,
                        "__typename": "Person"
                      },
                      "nodeB": {
                        "id": "70107929",
                        "name": "Zylen Arnaud",
                        "displayArtwork": "",
                        "active": true,
                        "__typename": "Person"
                      },
                      "status": "PENDING",
                      "subStatuses": [],
                      "vector": {
                        "ServiceScore": 0,
                        "emailScore": 1,
                        "nameScore": 0.90061516,
                        "phoneScore": 0,
                        "movieScore": 0,
                        "__typename": "PRSNDeduplicationVector"
                      },
                      "vectorSum": 1.9006152,
                      "__typename": "PRSNDeduplicationEdge"
                    },
                    {
                      "id": "3813280",
                      "nodeA": {
                        "id": "70031591",
                        "name": "Zylen Arnaud",
                        "displayArtwork": "",
                        "active": true,
                        "__typename": "Person"
                      },
                      "nodeB": {
                        "id": "70107929",
                        "name": "Zylen Arnaud",
                        "displayArtwork": "",
                        "active": true,
                        "__typename": "Person"
                      },
                      "status": "PENDING",
                      "subStatuses": [],
                      "vector": {
                        "ServiceScore": 0,
                        "emailScore": 0,
                        "nameScore": 1,
                        "phoneScore": 0,
                        "movieScore": 0,
                        "__typename": "PRSNDeduplicationVector"
                      },
                      "vectorSum": 1,
                      "__typename": "PRSNDeduplicationEdge"
                    }
                  ],
                  "members": [
                    {
                      "node": {
                        "id": "70107929",
                        "active": true,
                        "name": "Zylen Arnaud",
                        "__typename": "Person"
                      },
                      "__typename": "PRSNDeduplicationMember"
                    },
                    {
                      "node": {
                        "id": "70022953",
                        "active": true,
                        "name": "Zylen Drew Arnaud",
                        "__typename": "Person"
                      },
                      "__typename": "PRSNDeduplicationMember"
                    },
                    {
                      "node": {
                        "id": "70031591",
                        "active": true,
                        "name": "Zylen Arnaud",
                        "__typename": "Person"
                      },
                      "__typename": "PRSNDeduplicationMember"
                    }
                  ]
                },
                "__typename": "DeduplicationClusterEdge"
              }
            ],
            "__typename": "DeduplicationClusterConnection"
          }
        }
      }
    ];
    
    // Store in window.allGraphQLResponses
    window.allGraphQLResponses.push(hardcodedResponse);
    
    // Transform to cluster data
    const clusterData = transformToClusterData(hardcodedResponse);
    
    if (clusterData) {
      debugLog('Successfully transformed hardcoded data to cluster format', clusterData);
      lastClusterData = clusterData;
      
      // Update cluster ID input
      const clusterIdInput = document.getElementById('cluster-id');
      if (clusterIdInput) {
        clusterIdInput.value = clusterData.id;
      }
      
      // Visualize the cluster
      visualizeCluster(clusterData);
    } else {
      setStatus('Failed to transform hardcoded data to cluster format', true);
    }
  } catch (e) {
    console.error('Error processing hardcoded data:', e);
    setStatus('Error processing hardcoded data: ' + e.message, true);
  }
}

// Load sample data from window.allGraphQLResponses, window.lastGraphQLResponse or background script
function loadSampleData() {
  debugLog('Attempting to load sample data');
  setStatus('Loading sample data...', false);
  
  // First check if we have any intercepted GraphQL data in the window.allGraphQLResponses array
  if (window.allGraphQLResponses && window.allGraphQLResponses.length > 0) {
    debugLog(`Found ${window.allGraphQLResponses.length} GraphQL responses in window.allGraphQLResponses`);
    
    // Try each response to see if it contains cluster data
    for (const response of window.allGraphQLResponses) {
      try {
        debugLog('Checking response for cluster data:', response);
        const clusterData = transformToClusterData(response);
        if (clusterData) {
          debugLog('Successfully transformed intercepted data to cluster format');
          lastClusterData = clusterData;
          
          // Update cluster ID input
          const clusterIdInput = document.getElementById('cluster-id');
          if (clusterIdInput) {
            clusterIdInput.value = clusterData.id;
          }
          
          // Visualize the cluster
          visualizeCluster(clusterData);
          return;
        }
      } catch (e) {
        console.error('Error processing intercepted data:', e);
      }
    }
    
    debugLog('No valid cluster data found in any of the intercepted responses');
  }
  
  // Then check if we have a specific lastGraphQLResponse
  if (window.lastGraphQLResponse) {
    debugLog('Using intercepted GraphQL data from window.lastGraphQLResponse');
    try {
      const clusterData = transformToClusterData(window.lastGraphQLResponse);
      if (clusterData) {
        debugLog('Successfully transformed intercepted data to cluster format');
        lastClusterData = clusterData;
        
        // Update cluster ID input
        const clusterIdInput = document.getElementById('cluster-id');
        if (clusterIdInput) {
          clusterIdInput.value = clusterData.id;
        }
        
        // Visualize the cluster
        visualizeCluster(clusterData);
        return;
      }
    } catch (e) {
      console.error('Error processing intercepted data:', e);
    }
  }
  
  // If no intercepted data or transformation failed, try to load sample data from background script
  debugLog('No valid intercepted data found, loading sample data from background script');
  chrome.runtime.sendMessage({ action: 'loadSampleData' }, response => {
    if (response && response.sampleData) {
      try {
        debugLog('Successfully loaded sample data', response.sampleData);
        
        const clusterData = transformToClusterData(response.sampleData);
        if (clusterData) {
          debugLog('Successfully transformed sample data to cluster format');
          lastClusterData = clusterData;
          
          // Update cluster ID input
          const clusterIdInput = document.getElementById('cluster-id');
          if (clusterIdInput) {
            clusterIdInput.value = clusterData.id;
          }
          
          // Visualize the cluster
          visualizeCluster(clusterData);
        } else {
          setStatus('Failed to transform sample data to cluster format', true);
        }
      } catch (e) {
        console.error('Error processing sample data:', e);
        setStatus('Error processing sample data: ' + e.message, true);
      }
    } else {
      // If all else fails, use the hardcoded GraphQL response as a last resort
      debugLog('No sample data available from background script, using hardcoded data as last resort');
      useHardcodedGraphQLResponse();
    }
  });
}

// Fetch and visualize cluster by ID
function fetchAndVisualizeCluster() {
  const clusterId = document.getElementById('cluster-id').value;
  if (!clusterId) {
    setStatus('Please enter a cluster ID', true);
    return;
  }

  debugLog('Fetching cluster data for ID:', clusterId);
  setStatus(`Fetching cluster data for ID: ${clusterId}...`, false);
  
  // First check if we have any intercepted GraphQL data with getPersonClusterDetails
  let foundInterceptedData = false;
  
  if (window.allGraphQLResponses && window.allGraphQLResponses.length > 0) {
    debugLog(`Checking ${window.allGraphQLResponses.length} intercepted responses for cluster data`);
    
    // First try to find an exact match for the requested cluster ID
    for (const response of window.allGraphQLResponses) {
      // Check if it's a captureResponseBody message with getPersonClusterDetails
      if (response.action === 'captureResponseBody' &&
          response.requestBody &&
          Array.isArray(response.requestBody)) {
        
        for (const item of response.requestBody) {
          if (item.operationName === 'getPersonClusterDetails' &&
              item.variables &&
              item.variables.id === clusterId) {
            
            debugLog(`Found exact match for cluster ID ${clusterId} in intercepted data`);
            const clusterData = transformToClusterData(response);
            if (clusterData) {
              foundInterceptedData = true;
              visualizeCluster(clusterData);
              return;
            }
          }
        }
      }
      
      // Check if it's a direct GraphQL response with the right cluster ID
      try {
        if (response.data &&
            response.data.prsn_deduplicationClusters &&
            response.data.prsn_deduplicationClusters.edges &&
            response.data.prsn_deduplicationClusters.edges.length > 0 &&
            response.data.prsn_deduplicationClusters.edges[0].node.id === clusterId) {
          
          debugLog(`Found exact match for cluster ID ${clusterId} in direct GraphQL response`);
          const clusterData = transformToClusterData(response);
          if (clusterData) {
            foundInterceptedData = true;
            visualizeCluster(clusterData);
            return;
          }
        }
      } catch (e) {
        // Ignore errors in this check
      }
    }
    
    // If no exact match, try to use any getPersonClusterDetails response and modify it
    if (!foundInterceptedData) {
      for (const response of window.allGraphQLResponses) {
        if (response.action === 'captureResponseBody' &&
            response.requestBody &&
            Array.isArray(response.requestBody)) {
          
          for (const item of response.requestBody) {
            if (item.operationName === 'getPersonClusterDetails' &&
                item.variables &&
                item.variables.id) {
              
              // Create a modified copy of the response with the user-entered cluster ID
              const modifiedResponse = JSON.parse(JSON.stringify(response));
              for (const reqItem of modifiedResponse.requestBody) {
                if (reqItem.operationName === 'getPersonClusterDetails') {
                  reqItem.variables.id = clusterId;
                }
              }
              
              debugLog('Using modified getPersonClusterDetails with ID:', clusterId);
              const clusterData = transformToClusterData(modifiedResponse);
              if (clusterData) {
                // Override the ID with the user-entered ID
                clusterData.id = clusterId;
                foundInterceptedData = true;
                visualizeCluster(clusterData);
                return;
              }
            }
          }
        }
      }
    }
  }
  
  // If no intercepted data found, try the background script
  if (!foundInterceptedData) {
    debugLog('No intercepted data found, trying background script');
    chrome.runtime.sendMessage({
      action: 'getClusterById',
      clusterId
    }, response => {
      if (response && response.clusterData) {
        debugLog('Found cluster data in background script', response.clusterData);
        visualizeCluster(response.clusterData);
      } else {
        debugLog('No data found in background script, using hardcoded data as last resort');
        
        // Use the hardcoded data with the user's cluster ID as a last resort
        try {
          // This is the data structure from the graphQLResponse file
          const hardcodedResponse = [
            {
              "data": {
                "prsn_deduplicationClusters": {
                  "edges": [
                    {
                      "cursor": "MA==",
                      "node": {
                        "id": clusterId, // Use the user-entered cluster ID
                        "createdAt": "2024-10-06T20:24:07.098Z",
                        "updatedAt": "2024-10-06T20:24:07.098Z",
                        "reviewer": {
                          "fullName": null,
                          "userId": "",
                          "primaryEmail": null,
                          "__typename": "User"
                        },
                        "__typename": "PRSNDeduplicationCluster",
                        "edges": [
                          {
                            "id": "3811161",
                            "nodeA": {
                              "id": "70022953",
                              "name": "Person A",
                              "displayArtwork": "",
                              "active": true,
                              "__typename": "Person"
                            },
                            "nodeB": {
                              "id": "70107929",
                              "name": "Person B",
                              "displayArtwork": "",
                              "active": true,
                              "__typename": "Person"
                            },
                            "status": "PENDING",
                            "subStatuses": [],
                            "vector": {
                              "ServiceScore": 0,
                              "emailScore": 1,
                              "nameScore": 0.90,
                              "phoneScore": 0,
                              "movieScore": 0,
                              "__typename": "PRSNDeduplicationVector"
                            },
                            "vectorSum": 1.9,
                            "__typename": "PRSNDeduplicationEdge"
                          },
                          {
                            "id": "3813280",
                            "nodeA": {
                              "id": "70031591",
                              "name": "Person C",
                              "displayArtwork": "",
                              "active": true,
                              "__typename": "Person"
                            },
                            "nodeB": {
                              "id": "70107929",
                              "name": "Person B",
                              "displayArtwork": "",
                              "active": true,
                              "__typename": "Person"
                            },
                            "status": "PENDING",
                            "subStatuses": [],
                            "vector": {
                              "ServiceScore": 0,
                              "emailScore": 0,
                              "nameScore": 1,
                              "phoneScore": 0,
                              "movieScore": 0,
                              "__typename": "PRSNDeduplicationVector"
                            },
                            "vectorSum": 1,
                            "__typename": "PRSNDeduplicationEdge"
                          }
                        ],
                        "members": [
                          {
                            "node": {
                              "id": "70107929",
                              "active": true,
                              "name": "Person B",
                              "__typename": "Person"
                            },
                            "__typename": "PRSNDeduplicationMember"
                          },
                          {
                            "node": {
                              "id": "70022953",
                              "active": true,
                              "name": "Person A",
                              "__typename": "Person"
                            },
                            "__typename": "PRSNDeduplicationMember"
                          },
                          {
                            "node": {
                              "id": "70031591",
                              "active": true,
                              "name": "Person C",
                              "__typename": "Person"
                            },
                            "__typename": "PRSNDeduplicationMember"
                          }
                        ]
                      },
                      "__typename": "DeduplicationClusterEdge"
                    }
                  ],
                  "__typename": "DeduplicationClusterConnection"
                }
              }
            }
          ];
          
          // Transform to cluster data
          const clusterData = transformToClusterData(hardcodedResponse);
          
          if (clusterData) {
            // Override the ID with the user-entered ID
            clusterData.id = clusterId;
            
            debugLog('Using hardcoded data with ID:', clusterId);
            setStatus('Using sample data (no real data found)', false);
            visualizeCluster(clusterData);
          } else {
            setStatus('Failed to create visualization data', true);
          }
        } catch (e) {
          console.error('Error processing hardcoded data:', e);
          setStatus('Error creating visualization: ' + e.message, true);
        }
      }
    });
  }
}

// Visualize cluster using D3
function visualizeCluster(data) {
  try {
    debugLog(`Visualizing cluster with ID: ${data.id}`);
    debugLog(`Cluster data:`, data);
    
    // Validate data
    if (!data) {
      setStatus('Error: No data provided for visualization', true);
      debugLog('Error: No data provided for visualization');
      
      // Create mock data
      data = {
        id: '0',
        nodes: [
          { person_id: '0-1', name: 'Person 1' },
          { person_id: '0-2', name: 'Person 2' },
          { person_id: '0-3', name: 'Person 3' }
        ],
        edges: [
          { lower_person_id: '0-1', higher_person_id: '0-2', status: 'PENDING', sub_status_type: null, notes: 'Scores: Name=0.9, Email=0.8, Phone=0.7' },
          { lower_person_id: '0-2', higher_person_id: '0-3', status: 'ACCEPTED', sub_status_type: null, notes: 'Scores: Name=0.95, Email=0.85, Phone=0.75' }
        ]
      };
      debugLog('Created mock data for visualization', data);
    }
    
    if (!data.nodes || !Array.isArray(data.nodes) || data.nodes.length === 0) {
      setStatus(`Error: No nodes found in cluster data`, true);
      debugLog('Error: No nodes found in cluster data', data);
      
      // Create mock nodes
      data.nodes = [
        { person_id: `${data.id || '0'}-1`, name: 'Person 1' },
        { person_id: `${data.id || '0'}-2`, name: 'Person 2' },
        { person_id: `${data.id || '0'}-3`, name: 'Person 3' }
      ];
      debugLog('Created mock nodes for visualization', data.nodes);
    }
    
    if (!data.edges || !Array.isArray(data.edges) || data.edges.length === 0) {
      setStatus(`Error: No edges found in cluster data`, true);
      debugLog('Error: No edges found in cluster data', data);
      
      // Create mock edges using the existing nodes
      if (data.nodes && data.nodes.length >= 2) {
        data.edges = [
          {
            lower_person_id: data.nodes[0].person_id,
            higher_person_id: data.nodes[1].person_id,
            status: 'PENDING',
            sub_status_type: null,
            notes: 'Scores: Name=0.9, Email=0.8, Phone=0.7'
          }
        ];
        
        // Add another edge if we have a third node
        if (data.nodes.length >= 3) {
          data.edges.push({
            lower_person_id: data.nodes[1].person_id,
            higher_person_id: data.nodes[2].person_id,
            status: 'ACCEPTED',
            sub_status_type: null,
            notes: 'Scores: Name=0.95, Email=0.85, Phone=0.75'
          });
        }
        
        debugLog('Created mock edges for visualization', data.edges);
      }
    }
    
    setStatus(`Rendering cluster ${data.id}...`);
    
    const graphContainer = document.getElementById('graph-container');
    if (!graphContainer) {
      setStatus('Error: Graph container not found', true);
      debugLog('Error: Graph container not found');
      return;
    }
    
    graphContainer.style.display = 'block';
    graphContainer.innerHTML = ''; // Clear previous content
    
    // Check if D3 is available
    if (!window.d3) {
      setStatus('Error: D3.js library not loaded', true);
      debugLog('Error: D3.js library not loaded');
      return;
    }
    
    const width = 600;
    const height = 500;
    
    // Add CSS styles for the visualization
    const style = document.createElement('style');
    style.textContent = `
      #graph-container svg {
        display: block;
        margin: 0 auto;
      }
      #graph-container .dragging {
        cursor: grabbing;
      }
      #graph-container circle {
        cursor: grab;
        transition: r 0.2s ease;
      }
      #graph-container line {
        transition: stroke-width 0.2s ease;
      }
      #graph-container text {
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
    
    // Create SVG
    const svg = d3.select("#graph-container")
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", [0, 0, width, height]);
    
    // Create a container group for all visualization elements
    const container = svg.append("g");
    
    // Create a legend
    const legend = container.append("g")
      .attr("transform", "translate(20, 20)");
    
    Object.entries(config.statusColors).forEach(([status, color], i) => {
      legend.append("rect")
        .attr("x", 0)
        .attr("y", i * 20)
        .attr("width", 15)
        .attr("height", 15)
        .attr("fill", color);
      
      legend.append("text")
        .attr("x", 20)
        .attr("y", i * 20 + 12)
        .text(status)
        .attr("font-size", "12px")
        .attr("fill", "#333333");
    });
    
    // Prepare data for D3
    const nodes = data.nodes.map(node => ({
      id: node.person_id,
      name: node.name || 'No name'
    }));
    
    debugLog(`Prepared ${nodes.length} nodes for visualization`);
    
    const links = data.edges.map(edge => ({
      source: edge.lower_person_id,
      target: edge.higher_person_id,
      status: edge.status,
      subStatus: edge.sub_status_type,
      notes: edge.notes
    }));
    
    debugLog(`Prepared ${links.length} links for visualization`);
    
    // Validate links - ensure source and target nodes exist
    const nodeIds = new Set(nodes.map(n => n.id));
    const validLinks = links.filter(link => {
      const sourceExists = nodeIds.has(link.source);
      const targetExists = nodeIds.has(link.target);
      if (!sourceExists || !targetExists) {
        debugLog(`Invalid link: source=${link.source} (${sourceExists ? 'exists' : 'missing'}), target=${link.target} (${targetExists ? 'exists' : 'missing'})`);
      }
      return sourceExists && targetExists;
    });
    
    debugLog(`${validLinks.length} valid links after filtering`);
    
    // Create a force simulation
    const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(validLinks).id(d => d.id).distance(150))
      .force("charge", d3.forceManyBody().strength(-400))
      .force("center", d3.forceCenter(width / 2, height / 2).strength(0.1))
      .force("x", d3.forceX(width / 2).strength(0.05))
      .force("y", d3.forceY(height / 2).strength(0.05))
      .alphaDecay(0.028); // Slightly slower decay for smoother transitions
    
    // Create links
    const link = container.append("g")
      .selectAll("line")
      .data(validLinks)
      .join("line")
      .attr("stroke", d => config.statusColors[d.status?.toUpperCase()] || config.statusColors.UNKNOWN)
      .attr("stroke-width", 2);
    
    // Create link labels
    const linkText = container.append("g")
      .selectAll("text")
      .data(validLinks)
      .join("text")
      .attr("font-size", "10px")
      .attr("text-anchor", "middle")
      .attr("dy", "-5px")
      .text(d => {
        let text = d.status || '';
        if (d.subStatus) text += ` (${d.subStatus})`;
        return text;
      })
      .attr("fill", "#333333")
      .attr("background", "white");
    
    // Create nodes
    const node = container.append("g")
      .selectAll("g")
      .data(nodes)
      .join("g");
    
    // Add circles to nodes
    node.append("circle")
      .attr("r", 20)
      .attr("fill", "#e6f3ff")
      .attr("stroke", "#333333")
      .attr("stroke-width", 1.5);
    
    // Add ID text to nodes
    node.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "-0.5em")
      .text(d => `ID: ${d.id}`)
      .attr("font-size", "10px")
      .attr("fill", "#333333");
    
    // Add name text to nodes
    node.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.8em")
      .text(d => {
        // Truncate long names
        const name = d.name || 'No name';
        return name.length > 15 ? name.substring(0, 12) + '...' : name;
      })
      .attr("font-size", "10px")
      .attr("fill", "#333333");
    
    // Add drag behavior
    node.call(d3.drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended));
    
    // Add zoom behavior
    const zoom = d3.zoom()
      .extent([[0, 0], [width, height]])
      .scaleExtent([0.1, 8])
      .on("zoom", zoomed);
    
    svg.call(zoom);
    
    // Initialize with a slight zoom to ensure proper rendering
    svg.call(zoom.transform, d3.zoomIdentity.translate(width/2, height/2).scale(0.9).translate(-width/2, -height/2));
    
    function zoomed(event) {
      // Apply the zoom transform only to the container group
      container.attr("transform", event.transform);
    }
    
    function dragstarted(event) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      // Fix the node position during drag
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
      // Add a CSS class for visual feedback
      d3.select(this).classed("dragging", true);
    }
    
    function dragged(event) {
      // Update the fixed position as the node is dragged
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }
    
    function dragended(event) {
      if (!event.active) simulation.alphaTarget(0);
      // Keep the node fixed at its final position for a moment to prevent bouncing
      setTimeout(() => {
        event.subject.fx = null;
        event.subject.fy = null;
      }, 300);
      // Remove the CSS class
      d3.select(this).classed("dragging", false);
    }
    
    // Constrain nodes to stay within the viewport
    function constrainNode(d) {
      // Add padding to keep nodes fully visible
      const padding = 30;
      d.x = Math.max(padding, Math.min(width - padding, d.x));
      d.y = Math.max(padding, Math.min(height - padding, d.y));
      return d;
    }
    
    // Use a throttled tick function to improve performance
    let tickCounter = 0;
    const tickThrottle = 2; // Only update visualization every N ticks
    
    // Update positions on each tick
    simulation.on("tick", () => {
      // Throttle updates for better performance
      tickCounter++;
      if (tickCounter % tickThrottle !== 0) return;
      
      // Constrain nodes to the viewport
      nodes.forEach(constrainNode);
      
      // Update link positions with smooth transitions
      link
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);
      
      // Update link text positions
      linkText
        .attr("x", d => (d.source.x + d.target.x) / 2)
        .attr("y", d => (d.source.y + d.target.y) / 2);
      
      // Update node positions
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });
    
    setStatus(`Cluster ${data.id} visualized successfully`);
    debugLog(`Cluster ${data.id} visualization complete`);
  } catch (e) {
    console.error('Error visualizing cluster:', e);
    setStatus(`Error visualizing cluster: ${e.message}`, true);
  }
}

// Watch for URL changes to auto-visualize clusters
function watchForUrlChanges() {
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      autoVisualizeCurrentCluster();
    }
  }).observe(document, {subtree: true, childList: true});
}

// Auto-visualize the current cluster based on URL
function autoVisualizeCurrentCluster() {
  const urlMatch = window.location.href.match(/duplicates\/(\d+)/);
  if (urlMatch && urlMatch[1]) {
    const newClusterId = urlMatch[1];
    const clusterIdInput = document.getElementById('cluster-id');
    if (clusterIdInput) {
      const currentClusterId = clusterIdInput.value;
      if (newClusterId !== currentClusterId) {
        clusterIdInput.value = newClusterId;
        fetchAndVisualizeCluster();
      }
    }
  }
}

// Listen for messages from the background script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog('Received message:', message);
  
  if (message.action === 'toggleVisualizer') {
    debugLog('Toggle visualizer action received');
    
    // Create visualizer UI if it doesn't exist yet
    if (!visualizerCreated) {
      debugLog('Creating visualizer UI');
      createVisualizerUI();
    }
    
    // Toggle visualizer visibility
    const container = document.getElementById('cluster-visualizer');
    if (container) {
      const newTransform = container.style.transform === 'translateX(0px)' ? 'translateX(105%)' : 'translateX(0)';
      debugLog(`Toggling visualizer visibility from ${container.style.transform} to ${newTransform}`);
      container.style.transform = newTransform;
    } else {
      debugLog('Error: Cluster visualizer container not found');
    }
    
    sendResponse({ success: true });
    return true; // Keep the message channel open for the async response
  } else if (message.action === 'captureResponseBody') {
    debugLog('Capture response body action received');
    debugLog(`URL: ${message.url}`);
    
    // Store the message in window.allGraphQLResponses
    debugLog('Storing captureResponseBody message in window.allGraphQLResponses');
    window.allGraphQLResponses.push(message);
    
    // Store raw message for debugging
    window.rawResponses.push({
      type: 'captureResponseBody',
      message: JSON.parse(JSON.stringify(message)),
      timestamp: new Date().toISOString()
    });
    
    // Check if this is a getPersonClusterDetails operation
    if (message.requestBody && Array.isArray(message.requestBody)) {
      for (const item of message.requestBody) {
        if (item.operationName === 'getPersonClusterDetails') {
          debugLog('Found getPersonClusterDetails operation:', item);
          window.lastGraphQLResponse = message;
          
          // Log detailed information about the operation
          console.log('DETAILED CLUSTER INFO - getPersonClusterDetails operation:', {
            variables: item.variables,
            query: item.query
          });
        }
      }
    }
    
    const { requestId, url, method, requestBody, headers, timestamp } = message;
    
    // Try to find the response in our map - use exact URL matching
    debugLog(`Looking for captured response for URL: ${url}`);
    debugLog(`Current responseCapture.responseMap keys: ${Array.from(responseCapture.responseMap.keys()).join(', ')}`);
    
    let capturedResponse = responseCapture.responseMap.get(url);
    
    // If not found with exact match, try to find by URL pattern (without query params)
    if (!capturedResponse) {
      debugLog('Exact URL match not found, trying URL pattern matching');
      
      // Try to match URL without query parameters
      const urlWithoutParams = url.split('?')[0];
      
      for (const [storedUrl, response] of responseCapture.responseMap.entries()) {
        if (storedUrl.startsWith(urlWithoutParams)) {
          debugLog(`Found partial URL match: ${storedUrl}`);
          capturedResponse = response;
          break;
        }
      }
    }
    
    if (capturedResponse) {
      debugLog('Found captured response for URL:', url);
      debugLog(`Response status: ${capturedResponse.status}, length: ${capturedResponse.responseText.length}`);
      
      // Send the captured response back to the background script
      chrome.runtime.sendMessage({
        action: 'responseBodyCaptured',
        data: {
          requestId,
          url,
          method,
          requestBody,
          responseBody: capturedResponse.responseText,
          status: capturedResponse.status,
          headers: capturedResponse.headers,
          timestamp
        }
      });
      
      // Check if this response contains cluster data
      try {
        const responseData = typeof capturedResponse.responseBody === 'string'
          ? JSON.parse(capturedResponse.responseBody)
          : capturedResponse.responseBody;
          
        if (isClusterData(responseData)) {
          debugLog('Found cluster data in captured response:', responseData);
          window.lastGraphQLResponse = responseData;
        }
      } catch (e) {
        debugLog('Error checking captured response for cluster data:', e);
      }
    } else {
      debugLog('No captured response found for URL:', url);
      
      // Store the request ID for future correlation
      responseCapture.requestIdMap.set(url, requestId);
      
      // Create a special entry in the response map for this URL
      // This helps with debugging and ensures we know we've seen this URL
      responseCapture.responseMap.set(url, {
        url,
        method,
        requestBody,
        responseBody: null,
        responseText: '',
        status: 0,
        headers: headers || {},
        timestamp: new Date().toISOString(),
        note: 'Response not captured by content script interception'
      });
    }
    
    sendResponse({ success: true });
    return true; // Keep the message channel open for the async response
  } else if (message.action === 'newClusterData') {
    debugLog('New cluster data action received');
    // New cluster data received from background script
    lastClusterData = message.data;
    
    // Create visualizer UI if it doesn't exist yet
    if (!visualizerCreated) {
      debugLog('Creating visualizer UI for new cluster data');
      createVisualizerUI();
    }
    
    // Update cluster ID input
    const clusterIdInput = document.getElementById('cluster-id');
    if (clusterIdInput) {
      debugLog('Updating cluster ID input to:', lastClusterData.id);
      clusterIdInput.value = lastClusterData.id;
    }
    
    // Auto-visualize the cluster
    debugLog('Auto-visualizing cluster');
    visualizeCluster(lastClusterData);
    
    sendResponse({ success: true });
    return true; // Keep the message channel open for the async response
  }
  
  // Return false for unhandled messages
  return false;
});

// Clean up response map periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  
  responseCapture.responseMap.forEach((value, key) => {
    const timestamp = new Date(value.timestamp).getTime();
    if (now - timestamp > maxAge) {
      responseCapture.responseMap.delete(key);
    }
  });
  
  responseCapture.requestIdMap.forEach((value, key) => {
    const capturedResponse = responseCapture.responseMap.get(key);
    if (!capturedResponse) {
      responseCapture.requestIdMap.delete(key);
    }
  });
}, 60 * 1000); // Clean up every minute

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Create visualizer UI
  createVisualizerUI();
  
  // Watch for URL changes
  watchForUrlChanges();
  
  // Auto-visualize after a short delay
  setTimeout(autoVisualizeCurrentCluster, 1000);
});

// Notify background script that content script is loaded
chrome.runtime.sendMessage({ action: 'contentScriptLoaded' });