const WEB_APP_URL = "http://localhost:3000";

interface AddProductMessage {
  type: "ADD_PRODUCT";
  product: {
    url: string;
    name?: string;
    description?: string;
    price?: string;
    image?: string;
  };
}

chrome.runtime.onMessage.addListener((message: AddProductMessage, _sender, sendResponse) => {
  if (message.type !== "ADD_PRODUCT") return;

  const params = new URLSearchParams({ source: "extension", sourceUrl: message.product.url });
  if (message.product.name) params.set("name", message.product.name);
  if (message.product.description) params.set("description", message.product.description);
  if (message.product.price) params.set("price", message.product.price);
  if (message.product.image) params.set("image", message.product.image);

  chrome.tabs.create({ url: `${WEB_APP_URL}/products/new?${params.toString()}` });
  sendResponse({ ok: true });
});
