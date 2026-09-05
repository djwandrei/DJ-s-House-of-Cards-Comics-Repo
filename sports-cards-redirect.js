(() => {
  const target = `shop.html${window.location.search}#sports-cards`;
  if (window.location.pathname.endsWith('/sports-cards.html')) {
    window.location.replace(target);
  }
})();
