import { NextRequest, NextResponse } from 'next/server';
import { orderCache, CacheService } from '@/lib/cache';

interface OrderRequest {
  order_number?: string;
  email?: string;
  tracking_number?: string;
}

interface OrderStatus {
  order_number: string;
  status: string;
  ship_date?: string;
  carrier?: string;
  tracking_number?: string;
  tracking_url?: string;
  estimated_delivery?: string;
  items: OrderItem[];
  shipping_address: ShippingAddress;
}

interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  status: string;
}

interface ShippingAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

/**
 * POST /api/tools/order-status
 * Get order status from ShipStation
 */
export async function POST(request: NextRequest) {
  try {
    const body: OrderRequest = await request.json();
    const { order_number, email, tracking_number } = body;

    if (!order_number && !email && !tracking_number) {
      return NextResponse.json(
        { error: 'Must provide order_number, email, or tracking_number' },
        { status: 400 }
      );
    }

    // Create cache key
    const cacheKey = CacheService.createKey(
      'order',
      order_number || '',
      email || '',
      tracking_number || ''
    );

    // Check cache first
    const cachedResponse = await orderCache.get(cacheKey);
    if (cachedResponse) {
      return NextResponse.json(cachedResponse);
    }

    // ShipStation API credentials from environment
    const apiKey = process.env.SHIPSTATION_API_KEY;
    const apiSecret = process.env.SHIPSTATION_API_SECRET;
    
    if (!apiKey || !apiSecret) {
      console.error('ShipStation credentials not configured');
      return NextResponse.json(
        { error: 'Order tracking service not configured' },
        { status: 503 }
      );
    }

    // Create Basic Auth header
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

    // Build ShipStation API query
    let endpoint = 'https://ssapi.shipstation.com/orders';
    const params = new URLSearchParams();

    if (order_number) {
      params.append('orderNumber', order_number);
    } else if (email) {
      params.append('customerEmail', email);
      params.append('orderStatus', 'shipped');
      params.append('sortBy', 'OrderDate');
      params.append('sortDir', 'DESC');
      params.append('pageSize', '10');
    } else if (tracking_number) {
      endpoint = 'https://ssapi.shipstation.com/shipments';
      params.append('trackingNumber', tracking_number);
    }

    // Make request to ShipStation
    const response = await fetch(`${endpoint}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('ShipStation API error:', response.status);
      return NextResponse.json(
        { 
          found: false,
          message: 'Unable to retrieve order information',
          search_criteria: { order_number, email, tracking_number },
        },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Process the response based on what we searched for
    let orders = [];
    
    if (tracking_number && endpoint.includes('shipments')) {
      // Convert shipments to order format
      const shipments = data.shipments || [];
      for (const shipment of shipments) {
        if (shipment.orderId) {
          // Fetch the full order details
          const orderResponse = await fetch(
            `https://ssapi.shipstation.com/orders/${shipment.orderId}`,
            {
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json',
              },
            }
          );
          
          if (orderResponse.ok) {
            const orderData = await orderResponse.json();
            orders.push(orderData);
          }
        }
      }
    } else {
      orders = data.orders || [];
    }

    if (orders.length === 0) {
      const notFoundResponse = {
        found: false,
        message: 'No orders found matching your criteria',
        search_criteria: { order_number, email, tracking_number },
        suggestion: 'Please check your order number or email address',
      };

      // Cache not found response for shorter time (5 minutes)
      await orderCache.set(cacheKey, notFoundResponse, { ttl: 300 });
      
      return NextResponse.json(notFoundResponse);
    }

    // Format the response for AI consumption
    const formattedOrders: OrderStatus[] = orders.map((order: any) => {
      // Get tracking info from shipments
      const shipment = order.shipments?.[0] || {};
      
      // Determine order status
      let status = 'Processing';
      if (order.orderStatus === 'shipped') {
        status = 'Shipped';
      } else if (order.orderStatus === 'delivered') {
        status = 'Delivered';
      } else if (order.orderStatus === 'cancelled') {
        status = 'Cancelled';
      } else if (order.orderStatus === 'awaiting_shipment') {
        status = 'Preparing for shipment';
      }

      // Build tracking URL
      let trackingUrl = '';
      if (shipment.trackingNumber) {
        if (shipment.carrierCode === 'ups') {
          trackingUrl = `https://www.ups.com/track?tracknum=${shipment.trackingNumber}`;
        } else if (shipment.carrierCode === 'fedex') {
          trackingUrl = `https://www.fedex.com/fedextrack/?trknbr=${shipment.trackingNumber}`;
        } else if (shipment.carrierCode === 'usps') {
          trackingUrl = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${shipment.trackingNumber}`;
        }
      }

      return {
        order_number: order.orderNumber,
        status,
        ship_date: shipment.shipDate || order.shipDate,
        carrier: shipment.carrierCode?.toUpperCase() || null,
        tracking_number: shipment.trackingNumber || null,
        tracking_url: trackingUrl || null,
        estimated_delivery: shipment.estimatedDeliveryDate || null,
        items: (order.items || []).map((item: any) => ({
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          status: item.fulfillmentStatus || 'pending',
        })),
        shipping_address: {
          name: order.shipTo?.name || '',
          street1: order.shipTo?.street1 || '',
          street2: order.shipTo?.street2 || '',
          city: order.shipTo?.city || '',
          state: order.shipTo?.state || '',
          postal_code: order.shipTo?.postalCode || '',
          country: order.shipTo?.country || 'US',
        },
      };
    });

    const finalResponse = {
      found: true,
      orders: formattedOrders,
      message: formattedOrders.length === 1 
        ? `Found order ${formattedOrders[0].order_number}`
        : `Found ${formattedOrders.length} orders`,
    };

    // Cache the response for 1 hour
    await orderCache.set(cacheKey, finalResponse, { ttl: 3600 });

    return NextResponse.json(finalResponse);

  } catch (error) {
    console.error('Order status error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to retrieve order status',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/tools/order-status
 * Get order status by order number
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const orderNumber = searchParams.get('order_number');
  
  if (!orderNumber) {
    return NextResponse.json(
      { error: 'Order number parameter required' },
      { status: 400 }
    );
  }

  // Delegate to POST handler
  return POST(new NextRequest(request.url, {
    method: 'POST',
    body: JSON.stringify({ order_number: orderNumber }),
  }));
}