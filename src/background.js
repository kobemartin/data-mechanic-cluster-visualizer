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
    /subscriptions/i,
    /zuul/i  // Added for Netflix's Zuul gateway
  ],
  // GraphQL query patterns to identify cluster data
  clusterQueryPatterns: [
    /prsn_deduplicationClusters/i,
    /deduplicationClusters/i,
    /clusters/i
  ]
};

// Store for intercepted requests
const requests = [];
let lastClusterData = null;

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
    sendResponse({ success: true });
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
  } else if (message.action === 'contentScriptLoaded') {
    // Content script has loaded
    console.log('Content script loaded in tab:', sender.tab ? sender.tab.id : 'unknown');
    sendResponse({ success: true });
  } else {
    console.log('Unknown message action:', message.action);
    sendResponse({ success: false, error: 'Unknown action' });
  }
  
  // Return true to indicate we'll respond asynchronously
  return true;
});

// Initialize
console.log('GraphQL Cluster Visualizer Extension background script loaded');