// Minimal webhook handler that just acknowledges Microsoft Graph webhooks
exports.handler = async (event) => {
  console.log('Webhook received:', JSON.stringify(event));

  // Handle validation request from Microsoft
  if (event.queryStringParameters && event.queryStringParameters.validationToken) {
    console.log('Validation request received');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/plain'
      },
      body: event.queryStringParameters.validationToken
    };
  }

  // Handle webhook notification
  if (event.httpMethod === 'POST') {
    try {
      const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      console.log('Webhook notification:', JSON.stringify(body));

      // For now, just acknowledge the webhook
      // The actual email processing happens via EmailProcessorFunction
      return {
        statusCode: 202,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: 'Webhook received',
          timestamp: new Date().toISOString()
        })
      };
    } catch (error) {
      console.error('Error processing webhook:', error);
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Failed to process webhook',
          details: error.message
        })
      };
    }
  }

  // Handle other HTTP methods
  return {
    statusCode: 405,
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      error: 'Method not allowed',
      method: event.httpMethod
    })
  };
};