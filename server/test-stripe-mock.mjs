const realFetch = globalThis.fetch;

if (process.env.NUMISTA_TEST_STRIPE_MOCK === '1') {
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (!url.startsWith('https://api.stripe.com/')) return realFetch(input, options);
    if (url !== 'https://api.stripe.com/v1/checkout/sessions' || options.method !== 'POST') {
      throw new Error(`Unexpected external Stripe API request in simulated test: ${url}`);
    }

    const form = new URLSearchParams(options.body);
    const orderId = form.get('metadata[order_id]');
    if (!orderId) throw new Error('Stripe mock request is missing order metadata');
    return new Response(JSON.stringify({
      id: `cs_test_${orderId}`,
      url: `https://checkout.stripe.test/${orderId}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
}
