// Background script for GraphQL Cluster Visualizer Extension
// Handles GraphQL request interception and communication with content script

// Configuration
const config = {
  // Max number of requests to store
  maxRequests: 100,
  // GraphQL path patterns to match (case insensitive)
  graphqlPatterns: [
    /graphql/i,
    /api\/gql/i,
    /\bgql\b/i,
    /query/i,
    /subscriptions/i
  ],
  // GraphQL query patterns to identify cluster data
  clusterQueryPatterns: [
    /prsn_deduplicationClusters/i,
    /deduplicationClusters/i,
    /clusters/i
  ],
  // Content types that might contain GraphQL data
  graphqlContentTypes: [
    'application/json',
    'application/graphql',
    'application/x-www-form-urlencoded'
  ]
};

// Store for intercepted requests
const requests = [];
let lastClusterData = null;
const requestBodyMap = new Map(); // Map to store request bodies by requestId

// Helper function to check if a URL is a GraphQL endpoint
function isGraphQLUrl(url) {
  return config.graphqlPatterns.some(pattern => pattern.test(url));
}

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
  } catch (e) {
    console.error('Error checking for cluster data:', e);
  }
  
  return false;
}

// Extract operation type from query
function getOperationType(query) {
  if (!query) return 'unknown';
  
  // Simple regex to determine operation type
  if (query.trim().startsWith('query')) return 'query';
  if (query.trim().startsWith('mutation')) return 'mutation';
  if (query.trim().startsWith('subscription')) return 'subscription';
  
  // Check for anonymous queries
  if (query.includes('{')) return 'query';
  
  return 'unknown';
}

// Transform GraphQL response to cluster data format
function transformToClusterData(response) {
  try {
    let clusterData = null;
    
    // Handle array response
    if (Array.isArray(response)) {
      for (const item of response) {
        if (item.data && item.data.prsn_deduplicationClusters) {
          clusterData = item.data.prsn_deduplicationClusters;
          break;
        }
      }
    }
    // Handle single response object
    else if (response.data && response.data.prsn_deduplicationClusters) {
      clusterData = response.data.prsn_deduplicationClusters;
    }
    
    if (!clusterData || !clusterData.edges || !clusterData.edges.length) {
      return null;
    }
    
    // Get the first cluster
    const cluster = clusterData.edges[0].node;
    
    if (!cluster || !cluster.edges || !cluster.members) {
      return null;
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
    
    return {
      id: cluster.id,
      nodes: nodes,
      edges: edges
    };
  } catch (e) {
    console.error('Error transforming GraphQL response to cluster data:', e);
    return null;
  }
}

// Store a new request
function storeRequest(request) {
  requests.unshift(request);
  
  // Limit the number of stored requests
  if (requests.length > config.maxRequests) {
    requests.pop();
  }
  
  // Check if this is cluster data
  if (isClusterData(request.response)) {
    const clusterData = transformToClusterData(request.response);
    if (clusterData) {
      lastClusterData = clusterData;
      console.log('Found cluster data:', clusterData);
      
      // Notify content script about new cluster data
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'newClusterData',
            data: clusterData
          });
        }
      });
    }
  }
}

// Process request body
function processRequestBody(requestBody) {
  if (!requestBody) return null;
  
  try {
    // Handle raw request body
    if (requestBody.raw && requestBody.raw.length) {
      const decoder = new TextDecoder('utf-8');
      const rawData = requestBody.raw.map(chunk => decoder.decode(new Uint8Array(chunk.bytes))).join('');
      
      try {
        return JSON.parse(rawData);
      } catch (e) {
        // Not JSON, might be form data or something else
        return rawData;
      }
    }
    
    // Handle form data
    if (requestBody.formData) {
      // Check if there's a query parameter which is common for GraphQL
      if (requestBody.formData.query) {
        return {
          query: requestBody.formData.query[0],
          variables: requestBody.formData.variables ? JSON.parse(requestBody.formData.variables[0]) : {},
          operationName: requestBody.formData.operationName ? requestBody.formData.operationName[0] : null
        };
      }
      return requestBody.formData;
    }
  } catch (e) {
    console.error('Error processing request body:', e);
  }
  
  return null;
}

// Process response body
function processResponseBody(responseText) {
  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.error('Error parsing response body:', e);
    return null;
  }
}

// Extract GraphQL operations from request body
function extractGraphQLOperations(body) {
  if (!body) return [];
  
  try {
    // Handle batched queries (array of operations)
    if (Array.isArray(body)) {
      return body.map(operation => ({
        operationName: operation.operationName || 'Unknown Operation',
        query: operation.query || '',
        variables: operation.variables || {},
        extensions: operation.extensions || null
      }));
    }
    
    // Handle single operation
    if (body.query || body.operationName) {
      return [{
        operationName: body.operationName || 'Unknown Operation',
        query: body.query || '',
        variables: body.variables || {},
        extensions: body.extensions || null
      }];
    }
  } catch (e) {
    console.error('Error extracting GraphQL operations:', e);
  }
  
  return [];
}

// Convert headers array to object
function headersToObject(headersArray) {
  const result = {};
  if (headersArray) {
    for (const header of headersArray) {
      result[header.name] = header.value;
    }
  }
  return result;
}

// Use a more direct approach to intercept network requests
// This will help us capture responses that might be happening before the content script is fully initialized

// Create a request observer using the Fetch API
const fetchObserver = {
  // Map to store pending requests
  pendingRequests: new Map(),
  
  // Initialize the observer
  init: function() {
    console.log('Initializing fetch observer');
    
    // Set up listeners for tab updates to inject the observer
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
        this.injectObserver(tabId);
      }
    });
    
    // Set up listeners for tab activation to check if we need to inject the observer
    chrome.tabs.onActivated.addListener((activeInfo) => {
      chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab.url && tab.url.startsWith('http')) {
          this.injectObserver(activeInfo.tabId);
        }
      });
    });
  },
  
  // Inject the observer into the page
  injectObserver: function(tabId) {
    console.log(`Injecting fetch observer into tab ${tabId}`);
    
    // Inject a content script that will directly intercept fetch and XHR requests
    chrome.tabs.executeScript(tabId, {
      code: `
        // Only inject once
        if (!window._graphqlObserverInjected) {
          window._graphqlObserverInjected = true;
          
          console.log('[GraphQL Observer] Injecting network interceptor');
          
          // Store original fetch
          const originalFetch = window.fetch;
          
          // Override fetch
          window.fetch = async function(resource, options = {}) {
            const url = resource instanceof Request ? resource.url : resource;
            
            // Only intercept GraphQL requests
            if (!/graphql|gql|query|subscriptions/i.test(url)) {
              return originalFetch.apply(this, arguments);
            }
            
            console.log('[GraphQL Observer] Intercepted fetch request to:', url);
            
            try {
              // Execute the original fetch
              const response = await originalFetch.apply(this, arguments);
              
              // Clone the response to avoid consuming the body
              const responseClone = response.clone();
              
              // Process the response asynchronously
              responseClone.text().then(responseText => {
                try {
                  console.log('[GraphQL Observer] Received fetch response from:', url);
                  
                  // Try to parse as JSON
                  let responseData;
                  try {
                    responseData = JSON.parse(responseText);
                  } catch (e) {
                    responseData = responseText;
                  }
                  
                  // Send the response to the background script
                  window.postMessage({
                    source: 'graphql-observer',
                    type: 'fetch-response',
                    url: url,
                    method: options.method || 'GET',
                    requestBody: options.body || null,
                    responseBody: responseData,
                    responseText: responseText,
                    status: response.status
                  }, '*');
                } catch (e) {
                  console.error('[GraphQL Observer] Error processing fetch response:', e);
                }
              });
              
              return response;
            } catch (error) {
              console.error('[GraphQL Observer] Error in fetch request:', error);
              throw error;
            }
          };
          
          // Store original XMLHttpRequest methods
          const originalXHROpen = XMLHttpRequest.prototype.open;
          const originalXHRSend = XMLHttpRequest.prototype.send;
          
          // Override XMLHttpRequest.open
          XMLHttpRequest.prototype.open = function(method, url) {
            this._graphqlObserver = { method, url };
            return originalXHROpen.apply(this, arguments);
          };
          
          // Override XMLHttpRequest.send
          XMLHttpRequest.prototype.send = function(body) {
            const xhr = this;
            const { method, url } = xhr._graphqlObserver || {};
            
            // Only intercept GraphQL requests
            if (!url || !/graphql|gql|query|subscriptions/i.test(url)) {
              return originalXHRSend.apply(this, arguments);
            }
            
            console.log('[GraphQL Observer] Intercepted XHR request to:', url);
            
            // Store the request body
            xhr._graphqlObserver.body = body;
            
            // Add response handler
            const originalOnReadyStateChange = xhr.onreadystatechange;
            xhr.onreadystatechange = function() {
              if (xhr.readyState === 4) {
                try {
                  console.log('[GraphQL Observer] Received XHR response from:', url);
                  
                  const responseText = xhr.responseText;
                  
                  // Try to parse as JSON
                  let responseData;
                  try {
                    responseData = JSON.parse(responseText);
                  } catch (e) {
                    responseData = responseText;
                  }
                  
                  // Send the response to the background script
                  window.postMessage({
                    source: 'graphql-observer',
                    type: 'xhr-response',
                    url: url,
                    method: method,
                    requestBody: xhr._graphqlObserver.body,
                    responseBody: responseData,
                    responseText: responseText,
                    status: xhr.status
                  }, '*');
                } catch (e) {
                  console.error('[GraphQL Observer] Error processing XHR response:', e);
                }
              }
              
              if (originalOnReadyStateChange) {
                originalOnReadyStateChange.apply(this, arguments);
              }
            };
            
            return originalXHRSend.apply(this, arguments);
          };
          
          // Listen for messages from the interceptors
          window.addEventListener('message', function(event) {
            // Only process messages from our interceptors
            if (event.source !== window || !event.data || event.data.source !== 'graphql-observer') {
              return;
            }
            
            // Forward the message to the extension
            chrome.runtime.sendMessage({
              action: 'networkIntercepted',
              data: event.data
            });
          });
          
          console.log('[GraphQL Observer] Network interceptor injected');
        }
      `,
      runAt: 'document_start'
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('Error injecting observer:', chrome.runtime.lastError);
      } else {
        console.log(`Observer injected into tab ${tabId}`);
      }
    });
  }
};

// Initialize the fetch observer
fetchObserver.init();

// Intercept web requests to capture request bodies (keep this as a backup)
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    console.log(`onBeforeRequest: ${details.method} ${details.url}`);
    
    // Process both GET and POST requests that might be GraphQL
    if (isGraphQLUrl(details.url)) {
      console.log(`Potential GraphQL request detected: ${details.method} ${details.url}`);
      
      // For POST requests, process the request body
      if (details.method === 'POST' && details.requestBody) {
        const requestBody = processRequestBody(details.requestBody);
        if (requestBody) {
          console.log(`Storing request body for ${details.requestId}`);
          requestBodyMap.set(details.requestId, requestBody);
          
          // Check if this is a getPersonClusterDetails operation
          if (Array.isArray(requestBody)) {
            for (const item of requestBody) {
              if (item.operationName === 'getPersonClusterDetails') {
                console.log('Found getPersonClusterDetails operation:', item);
              }
            }
          } else if (requestBody.operationName === 'getPersonClusterDetails') {
            console.log('Found getPersonClusterDetails operation:', requestBody);
          }
        }
      }
    }
    return { cancel: false };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestBody"]
);

// Intercept web responses to capture GraphQL data (keep this as a backup)
chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    console.log(`onHeadersReceived: ${details.method} ${details.url}`);
    
    // Process both GET and POST requests that might be GraphQL
    if (isGraphQLUrl(details.url)) {
      console.log(`Potential GraphQL response detected: ${details.method} ${details.url}`);
      
      // Get content type to verify it's likely GraphQL
      const contentTypeHeader = details.responseHeaders.find(h =>
        h.name.toLowerCase() === 'content-type'
      );
      
      const contentType = contentTypeHeader ? contentTypeHeader.value.toLowerCase() : '';
      console.log(`Content-Type: ${contentType}`);
      
      const isLikelyGraphQL = config.graphqlContentTypes.some(type => contentType.includes(type));
      
      // Process all responses from GraphQL URLs, even if content type doesn't match
      // This helps catch non-standard GraphQL implementations
      console.log(`Is likely GraphQL: ${isLikelyGraphQL}`);
      
      // We need to use the content script to get the response body
      // since webRequest API doesn't provide response bodies
      try {
        chrome.tabs.sendMessage(details.tabId, {
          action: 'captureResponseBody',
          requestId: details.requestId,
          url: details.url,
          method: details.method,
          requestBody: requestBodyMap.get(details.requestId),
          headers: headersToObject(details.responseHeaders),
          timestamp: new Date().toISOString()
        }, response => {
          if (chrome.runtime.lastError) {
            console.error('Error sending message to content script:', chrome.runtime.lastError);
          } else {
            console.log('Content script response:', response);
          }
        });
      } catch (e) {
        console.error('Error sending message to content script:', e);
      }
    }
    return { responseHeaders: details.responseHeaders };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "responseHeaders"]
);

// Clean up request body map when request is completed
chrome.webRequest.onCompleted.addListener(
  function(details) {
    requestBodyMap.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

// Load sample data from file
function loadSampleData() {
  // This is a hardcoded sample data from the graphQLResponse file
  const sampleData = [
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
                      "name": "Zylen Arnaud"
                    },
                    "__typename": "PRSNDeduplicationMember"
                  },
                  {
                    "node": {
                      "id": "70022953",
                      "active": true,
                      "name": "Zylen Drew Arnaud"
                    },
                    "__typename": "PRSNDeduplicationMember"
                  },
                  {
                    "node": {
                      "id": "70031591",
                      "active": true,
                      "name": "Zylen Arnaud"
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
  
  return sampleData;
}

// Set up message listeners for communication with content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background script received message:', message.action);
  
  if (message.action === 'getRequests') {
    console.log(`Returning ${requests.length} requests`);
    sendResponse({ requests });
  } else if (message.action === 'getLastClusterData') {
    console.log('Returning last cluster data:', lastClusterData ? 'found' : 'not found');
    sendResponse({ lastClusterData });
  } else if (message.action === 'clearData') {
    // Clear all stored requests and cluster data
    console.log('Clearing all stored data');
    requests.length = 0;
    lastClusterData = null;
    requestBodyMap.clear();
    sendResponse({ success: true });
  } else if (message.action === 'loadSampleData') {
    // Load sample data
    console.log('Loading sample data');
    const sampleData = loadSampleData();
    sendResponse({ sampleData });
  } else if (message.action === 'getClusterById') {
    const clusterId = message.clusterId;
    console.log(`Looking for cluster with ID: ${clusterId}`);
    
    const clusterRequest = requests.find(req => {
      if (isClusterData(req.response)) {
        const data = transformToClusterData(req.response);
        return data && data.id === clusterId;
      }
      return false;
    });
    
    if (clusterRequest) {
      console.log(`Found cluster with ID: ${clusterId}`);
      const clusterData = transformToClusterData(clusterRequest.response);
      sendResponse({ clusterData });
    } else {
      console.log(`No cluster found with ID: ${clusterId}`);
      sendResponse({ clusterData: null });
    }
  } else if (message.action === 'networkIntercepted') {
    // Process network request intercepted by our injected observer
    console.log('Network intercepted:', message.data.type);
    
    const { url, method, requestBody, responseBody, responseText, status } = message.data;
    console.log(`Intercepted ${message.data.type}: ${method} ${url}`);
    
    try {
      // Parse request body if it's a string
      let parsedRequestBody;
      try {
        parsedRequestBody = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
      } catch (e) {
        console.log('Request body is not JSON or is null');
        parsedRequestBody = requestBody;
      }
      
      // Extract GraphQL operations
      const operations = extractGraphQLOperations(parsedRequestBody);
      console.log(`Extracted ${operations.length} GraphQL operations`);
      
      // Check if this is a getPersonClusterDetails operation
      let isPersonClusterDetails = false;
      if (operations.length > 0) {
        for (const operation of operations) {
          if (operation.operationName === 'getPersonClusterDetails') {
            console.log('Found getPersonClusterDetails operation:', operation);
            isPersonClusterDetails = true;
          }
        }
      }
      
      // If we have operations, process each one
      if (operations.length > 0) {
        operations.forEach(operation => {
          const operationType = getOperationType(operation.query);
          console.log(`Operation: ${operation.operationName}, Type: ${operationType}`);
          
          const request = {
            timestamp: new Date(),
            url,
            method,
            operationName: operation.operationName || 'Unknown Operation',
            operationType,
            query: operation.query || '',
            variables: operation.variables || {},
            extensions: operation.extensions || null,
            response: responseBody,
            responseStatus: status,
            headers: {}
          };
          
          storeRequest(request);
          
          // If this is a getPersonClusterDetails operation, notify all tabs
          if (operation.operationName === 'getPersonClusterDetails' && isClusterData(responseBody)) {
            console.log('Found cluster data in getPersonClusterDetails response');
            
            // Notify all tabs about the new cluster data
            chrome.tabs.query({}, function(tabs) {
              const clusterData = transformToClusterData(responseBody);
              if (clusterData) {
                for (const tab of tabs) {
                  chrome.tabs.sendMessage(tab.id, {
                    action: 'newClusterData',
                    data: clusterData
                  }, response => {
                    if (chrome.runtime.lastError) {
                      // Ignore errors - tab might not have content script
                    }
                  });
                }
              }
            });
          }
        });
      } else {
        // If we couldn't extract operations but the URL suggests GraphQL, store as generic request
        if (isGraphQLUrl(url)) {
          console.log('No operations extracted, storing generic request');
          storeRequest({
            timestamp: new Date(),
            url,
            method,
            operationName: 'Unknown Operation',
            operationType: 'unknown',
            query: '',
            variables: {},
            extensions: null,
            response: responseBody,
            responseStatus: status,
            headers: {}
          });
        }
      }
      
      // Send the response to the content script for visualization
      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          action: 'captureResponseBody',
          requestId: `intercepted-${Date.now()}`,
          url,
          method,
          requestBody: parsedRequestBody,
          responseBody,
          status,
          headers: {},
          timestamp: new Date().toISOString()
        }, response => {
          if (chrome.runtime.lastError) {
            // Ignore errors - content script might not be ready
          }
        });
      }
      
      sendResponse({ success: true });
    } catch (e) {
      console.error('Error processing intercepted network request:', e);
      sendResponse({ success: false, error: e.message });
    }
  } else if (message.action === 'processGraphQLRequest') {
    // Process GraphQL request from content script
    const { url, method, requestBody, responseBody, status, headers, timestamp } = message.data;
    console.log(`Processing GraphQL request: ${method} ${url}`);
    
    try {
      // Parse request body
      let parsedBody;
      try {
        parsedBody = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
      } catch (e) {
        console.error('Error parsing request body:', e);
        console.log('Raw request body:', requestBody);
        sendResponse({ success: false, error: 'Error parsing request body' });
        return true;
      }
      
      // Extract GraphQL operations
      const operations = extractGraphQLOperations(parsedBody);
      console.log(`Extracted ${operations.length} GraphQL operations`);
      
      operations.forEach(operation => {
        const operationType = getOperationType(operation.query);
        console.log(`Operation: ${operation.operationName}, Type: ${operationType}`);
        
        storeRequest({
          timestamp: timestamp || new Date(),
          url,
          method,
          operationName: operation.operationName || 'Unknown Operation',
          operationType,
          query: operation.query || '',
          variables: operation.variables || {},
          extensions: operation.extensions || null,
          response: responseBody,
          responseStatus: status,
          headers
        });
      });
      
      sendResponse({ success: true });
    } catch (e) {
      console.error('Error processing GraphQL request:', e);
      sendResponse({ success: false, error: e.message });
    }
  } else if (message.action === 'responseBodyCaptured') {
    // Process response body captured by content script
    const { requestId, url, method, requestBody, responseBody, status, headers, timestamp } = message.data;
    console.log(`Processing captured response body: ${method} ${url}`);
    
    try {
      // Parse response body
      const parsedResponseBody = processResponseBody(responseBody);
      if (!parsedResponseBody) {
        console.log('Failed to parse response body');
        sendResponse({ success: false, error: 'Failed to parse response body' });
        return true;
      }
      
      console.log('Successfully parsed response body');
      
      // Extract GraphQL operations from request body
      const operations = extractGraphQLOperations(requestBody);
      console.log(`Extracted ${operations.length} GraphQL operations from request body`);
      
      if (operations.length > 0) {
        operations.forEach(operation => {
          const operationType = getOperationType(operation.query);
          console.log(`Operation: ${operation.operationName}, Type: ${operationType}`);
          
          storeRequest({
            timestamp: timestamp || new Date(),
            url,
            method,
            operationName: operation.operationName || 'Unknown Operation',
            operationType,
            query: operation.query || '',
            variables: operation.variables || {},
            extensions: operation.extensions || null,
            response: parsedResponseBody,
            responseStatus: status,
            headers
          });
        });
      } else {
        // If we couldn't extract operations, still store the request
        console.log('No operations extracted, storing generic request');
        storeRequest({
          timestamp: timestamp || new Date(),
          url,
          method,
          operationName: 'Unknown Operation',
          operationType: 'unknown',
          query: '',
          variables: {},
          extensions: null,
          response: parsedResponseBody,
          responseStatus: status,
          headers
        });
      }
      
      sendResponse({ success: true });
    } catch (e) {
      console.error('Error processing response body:', e);
      sendResponse({ success: false, error: e.message });
    }
  } else if (message.action === 'contentScriptLoaded') {
    // Content script has loaded, update icon
    console.log('Content script loaded in tab:', sender.tab ? sender.tab.id : 'unknown');
    if (sender.tab) {
      updateIcon(sender.tab.id, true);
      
      // Inject our network observer
      fetchObserver.injectObserver(sender.tab.id);
    }
    sendResponse({ success: true });
  } else {
    console.log('Unknown message action:', message.action);
    sendResponse({ success: false, error: 'Unknown action' });
  }
  
  // Return true to indicate we'll respond asynchronously
  return true;
});

// Set icon state based on whether we're on a page with GraphQL
function updateIcon(tabId, hasGraphQL) {
  chrome.browserAction.setIcon({
    path: {
      '16': hasGraphQL ? 'assets/icon16.png' : 'assets/icon16_off.png',
      '48': hasGraphQL ? 'assets/icon48.png' : 'assets/icon48_off.png',
      '128': hasGraphQL ? 'assets/icon128.png' : 'assets/icon128_off.png'
    },
    tabId
  });
}

// Initialize
console.log('GraphQL Cluster Visualizer Extension background script loaded');