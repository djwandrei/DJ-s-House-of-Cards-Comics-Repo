/**
 * Browser-local admin tools.
 * -----------------------------------------------------------------------------
 * This file powers the original static-site admin workflow: add custom products,
 * edit browser-only overrides for existing listings, export/import local changes,
 * and manage storefront-only deletions. In the backend-first build these tools are
 * still valuable as an offline/fallback editing layer.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;

  // Cache the static catalog request so the editor can reuse the same base data
  // across search, edit, restore, and import flows without refetching products.json.
  let baseProductsPromise = null;
  const customState = { search: '', category: 'All' };
  const existingState = {
    search: '',
    baseProducts: [],
    editingId: null,
    currentGallery: []
  };
  const MAX_EXISTING_RESULTS = 80;
  let existingEditorInitialized = false;
  let existingListingsReadyPromise = null;

  // ---------------------------------------------------------------------------
  // Shared helpers for the browser-local admin experience
  // ---------------------------------------------------------------------------

  function updateSearchShellState(inputId, shellId) {
    const input = document.getElementById(inputId);
    const shell = document.getElementById(shellId);
    if (!input || !shell) return;
    shell.classList.toggle('has-value', Boolean(input.value.trim()));
  }

  function formatCountLabel(count, singular, plural = `${singular}s`) {
    const numeric = Number(count) || 0;
    return `${numeric} ${numeric === 1 ? singular : plural}`;
  }

  function getStorageFailureMessage() {
    return 'This browser is out of storage space. Try smaller images or clear older custom items or storefront edits.';
  }

  function exportJsonFile(payload, filenamePrefix) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `${filenamePrefix}-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function resizeImageToDataUrl(file) {
    if (!file || !file.type.startsWith('image/')) {
      throw new Error('Please choose an image file.');
    }

    const fileDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that image file.'));
      reader.readAsDataURL(file);
    });

    const image = await new Promise((resolve, reject) => {
      const imageElement = new Image();
      imageElement.onload = () => resolve(imageElement);
      imageElement.onerror = () => reject(new Error('That image could not be processed.'));
      imageElement.src = fileDataUrl;
    });

    const maxDimension = 1400;
    let { width, height } = image;

    if (width > maxDimension || height > maxDimension) {
      const ratio = Math.min(maxDimension / width, maxDimension / height);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.88);
  }

  function wireDropzone(element, handlers = {}) {
    if (!element) return;
    const { onFiles, onClick } = handlers;

    ['dragenter', 'dragover'].forEach((eventName) => {
      element.addEventListener(eventName, (event) => {
        event.preventDefault();
        element.classList.add('is-dragover');
      });
    });

    ['dragleave', 'dragend', 'drop'].forEach((eventName) => {
      element.addEventListener(eventName, (event) => {
        event.preventDefault();
        if (eventName !== 'dragleave' || event.target === element) {
          element.classList.remove('is-dragover');
        }
      });
    });

    element.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length && typeof onFiles === 'function') {
        onFiles(files);
      }
    });

    element.addEventListener('click', () => {
      if (typeof onClick === 'function') onClick();
    });

    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (typeof onClick === 'function') onClick();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // New custom product form helpers
  // ---------------------------------------------------------------------------

  function updateDraftImagePreview(imageUrl = '', label = '') {
    const wrap = document.getElementById('imagePreviewWrap');
    const image = document.getElementById('imagePreview');
    const name = document.getElementById('imagePreviewName');
    const imageInput = document.getElementById('image');
    if (!wrap || !image || !name || !imageInput) return;

    if (!imageUrl) {
      wrap.hidden = true;
      image.removeAttribute('src');
      name.textContent = 'Selected image';
      wrap.removeAttribute('data-ready');
      return;
    }

    image.src = imageUrl;
    name.textContent = label || 'Selected image';
    wrap.hidden = false;
    wrap.setAttribute('data-ready', 'true');
    if (imageInput.value !== imageUrl) imageInput.value = imageUrl;
  }

  function clearDraftImage(options = {}) {
    const { keepUrl = false } = options;
    const imageInput = document.getElementById('image');
    const imageFile = document.getElementById('imageFile');
    if (imageFile) imageFile.value = '';
    if (imageInput && !keepUrl) imageInput.value = '';
    if (!keepUrl) updateDraftImagePreview('', '');
  }

  function replaceCustomProductImage(productId, imageUrl) {
    const customProducts = DJ.getCustomProducts();
    const index = customProducts.findIndex((item) => Number(item.id) === Number(productId));
    if (index === -1) return false;
    customProducts[index] = { ...customProducts[index], image: imageUrl };
    return DJ.saveCustomProducts(customProducts);
  }

  async function handleCustomProductImage(file, productId) {
    try {
      const imageUrl = await resizeImageToDataUrl(file);
      if (!replaceCustomProductImage(productId, imageUrl)) {
        DJ.setStatus('adminStatus', 'That image was too large to save locally. Try a smaller photo.', 'error');
        return;
      }
      renderCustomItems();
      DJ.setStatus('adminStatus', 'Item photo updated successfully.', 'success');
    } catch (error) {
      DJ.setStatus('adminStatus', error.message || 'Unable to use that image.', 'error');
    }
  }

  function deleteCustomProduct(productId) {
    const customProducts = DJ.getCustomProducts().filter((item) => Number(item.id) !== Number(productId));
    if (DJ.saveCustomProducts(customProducts)) {
      renderCustomItems();
      DJ.setStatus('adminStatus', 'Item removed.', 'success');
    } else {
      DJ.setStatus('adminStatus', 'Unable to delete that item right now.', 'error');
    }
  }

  function renderCustomItemCard(item) {
    return `
      <div class="custom-item-card" data-custom-item-id="${item.id}">
        <div class="custom-item-media">
          <img src="${DJ.escapeHtml(DJ.safeAssetUrl(item.image))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(DJ.fallbackByCategory[item.category] || DJ.fallbackByCategory.Other))}" alt="${DJ.escapeHtml(item.name)}">
          <div class="mini-dropzone" data-image-drop-id="${item.id}" role="button" tabindex="0">Drop new photo here or click to upload</div>
          <input accept="image/*" class="sr-only replace-image-input" data-replace-id="${item.id}" id="replaceImage-${item.id}" type="file">
        </div>
        <div>
          <h4>${DJ.escapeHtml(item.name)}</h4>
          <p>${DJ.escapeHtml(item.year)} | ${DJ.escapeHtml(item.category)}</p>
          <p>${DJ.escapeHtml(item.team || 'No team / publisher listed')}</p>
          <p>${DJ.escapeHtml(DJ.displayPrice(item))} | ${DJ.escapeHtml(item.condition || 'Condition not listed')}</p>
        </div>
        <button type="button" class="delete-button" data-delete-id="${item.id}">Delete</button>
      </div>
    `;
  }

  function updateAdminStats(items = DJ.getCustomProducts()) {
    const count = items.length;
    const withPhotos = items.filter((item) => item.image && !String(item.image).includes('placeholder-')).length;
    const categories = new Set(items.map((item) => item.category).filter(Boolean)).size;

    const countElement = document.getElementById('adminStatCount');
    const photosElement = document.getElementById('adminStatPhotos');
    const categoriesElement = document.getElementById('adminStatCategories');

    if (countElement) countElement.textContent = String(count);
    if (photosElement) photosElement.textContent = String(withPhotos);
    if (categoriesElement) categoriesElement.textContent = String(categories);
  }

  function getFilteredCustomProducts() {
    const searchText = customState.search.trim().toLowerCase();
    return DJ.getCustomProducts().filter((item) => {
      const matchesCategory = customState.category === 'All' || item.category === customState.category;
      const haystack = [item.name, item.team, item.category, item.condition, item.description, item.year].join(' ').toLowerCase();
      const matchesSearch = !searchText || haystack.includes(searchText);
      return matchesCategory && matchesSearch;
    });
  }

  function renderCustomItems() {
    const container = document.getElementById('customItemsList');
    const count = document.getElementById('customItemsCount');
    if (!container) return;

    const customProducts = DJ.getCustomProducts();
    const filteredProducts = getFilteredCustomProducts();
    updateAdminStats(customProducts);
    updateSearchShellState('customItemSearch', 'customItemSearchShell');

    if (count) {
      count.textContent = !customProducts.length
        ? 'No browser-saved items yet.'
        : filteredProducts.length === customProducts.length
          ? `${formatCountLabel(filteredProducts.length, 'local item')} saved in this browser.`
          : `${formatCountLabel(filteredProducts.length, 'local item')} shown from ${formatCountLabel(customProducts.length, 'saved item')}.`;
    }

    if (!customProducts.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No custom items yet</h3>
          <p>Use the form to add inventory. Everything is stored locally in your browser for now.</p>
        </div>
      `;
      DJ.applyLazyLoading(container);
      return;
    }

    if (!filteredProducts.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No saved items match those filters</h3>
          <p>Try a broader search, switch the category filter, or clear the filter bar.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filteredProducts.map(renderCustomItemCard).join('');

    container.querySelectorAll('[data-image-drop-id]').forEach((dropzone) => {
      const productId = dropzone.dataset.imageDropId;
      const input = container.querySelector(`#replaceImage-${productId}`);
      wireDropzone(dropzone, {
        onClick: () => input?.click(),
        onFiles: (files) => {
          const file = files[0];
          if (file) handleCustomProductImage(file, productId);
        }
      });
    });

    DJ.applyLazyLoading(container);
  }

  function bindCustomItemInteractions() {
    const container = document.getElementById('customItemsList');
    if (!container || container.dataset.bound === 'true') {
      return;
    }

    container.dataset.bound = 'true';
    container.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      const deleteButton = event.target.closest('[data-delete-id]');
      if (!deleteButton) return;
      deleteCustomProduct(deleteButton.dataset.deleteId);
    });

    container.addEventListener('change', (event) => {
      if (!(event.target instanceof Element)) return;
      const input = event.target.closest('.replace-image-input');
      if (!input) return;
      const file = input.files?.[0];
      if (file) handleCustomProductImage(file, input.dataset.replaceId);
      input.value = '';
    });
  }

  function exportCustomProducts(items) {
    exportJsonFile(items, 'dj-house-custom-items');
  }

  function parseImportedCustomProducts(rawItems) {
    if (!Array.isArray(rawItems)) {
      throw new Error('That file did not contain an item list.');
    }

    return rawItems
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => {
        const category = String(item.category || 'Other').trim() || 'Other';
        return {
          id: Number(item.id) || Date.now() + index,
          name: String(item.name || '').trim(),
          category,
          team: String(item.team || '').trim(),
          year: Number(item.year),
          condition: String(item.condition || '').trim(),
          price: Number(item.price),
          image: String(item.image || '').trim() || DJ.fallbackByCategory[category] || DJ.fallbackByCategory.Other,
          description: String(item.description || '').trim()
        };
      })
      .filter((item) => item.name && Number.isFinite(item.year) && Number.isFinite(item.price));
  }

  function initCustomProductsPanel() {
    const searchInput = document.getElementById('customItemSearch');
    const clearSearchButton = document.getElementById('customItemSearchClear');
    const categoryFilter = document.getElementById('customItemFilter');
    const exportButton = document.getElementById('exportCustomItems');
    const importInput = document.getElementById('importCustomItems');
    const clearButton = document.getElementById('clearCustomItems');
    const categoryPills = document.querySelectorAll('[data-category-pill]');
    const categorySelect = document.getElementById('category');

    searchInput?.addEventListener('input', () => {
      customState.search = searchInput.value;
      renderCustomItems();
    });

    searchInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !searchInput.value) return;
      event.preventDefault();
      searchInput.value = '';
      customState.search = '';
      renderCustomItems();
      DJ.setStatus('adminStatus', 'Local item search cleared.', 'info');
    });

    clearSearchButton?.addEventListener('click', () => {
      if (!searchInput || !searchInput.value) return;
      searchInput.value = '';
      customState.search = '';
      renderCustomItems();
      DJ.setStatus('adminStatus', 'Local item search cleared.', 'info');
    });

    categoryFilter?.addEventListener('change', () => {
      customState.category = categoryFilter.value;
      renderCustomItems();
    });

    exportButton?.addEventListener('click', () => {
      const customProducts = DJ.getCustomProducts();
      if (!customProducts.length) {
        DJ.setStatus('adminStatus', 'There are no local items to export yet.', 'info');
        return;
      }

      exportCustomProducts(customProducts);
      DJ.setStatus('adminStatus', 'Local inventory exported as a JSON backup.', 'success');
    });

    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;

      try {
        const imported = parseImportedCustomProducts(JSON.parse(await file.text()));
        if (!imported.length) {
          throw new Error('No valid items were found in that file.');
        }
        const merged = [...imported, ...DJ.getCustomProducts()];
        if (!DJ.saveCustomProducts(merged)) {
          throw new Error('Unable to save the imported items in this browser.');
        }
        renderCustomItems();
        DJ.setStatus('adminStatus', `${imported.length} item${imported.length === 1 ? '' : 's'} imported successfully.`, 'success');
      } catch (error) {
        DJ.setStatus('adminStatus', error.message || 'Unable to import that JSON file.', 'error');
      } finally {
        importInput.value = '';
      }
    });

    clearButton?.addEventListener('click', () => {
      if (!DJ.getCustomProducts().length) {
        DJ.setStatus('adminStatus', 'There are no local items to clear.', 'info');
        return;
      }

      if (window.confirm('Remove all locally added items from this browser? This will not affect the main catalog files.')) {
        if (DJ.saveCustomProducts([])) {
          customState.search = '';
          customState.category = 'All';
          if (searchInput) searchInput.value = '';
          if (categoryFilter) categoryFilter.value = 'All';
          renderCustomItems();
          DJ.setStatus('adminStatus', 'All local items were cleared from this browser.', 'success');
        } else {
          DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
        }
      }
    });

    categoryPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        const category = pill.dataset.categoryPill || '';
        if (categorySelect) categorySelect.value = category;
        categoryPills.forEach((candidate) => candidate.classList.toggle('active', candidate === pill));
        document.getElementById('name')?.focus();
      });
    });

    categorySelect?.addEventListener('change', () => {
      categoryPills.forEach((pill) => {
        pill.classList.toggle('active', pill.dataset.categoryPill === categorySelect.value);
      });
    });
  }

  function initNewItemForm() {
    const form = document.getElementById('adminForm');
    if (!form) return;

    const dropzone = document.getElementById('imageDropzone');
    const imageFileInput = document.getElementById('imageFile');
    const browseButton = document.getElementById('imageBrowseButton');
    const removeButton = document.getElementById('imageRemoveButton');
    const imageInput = document.getElementById('image');

    if (dropzone && imageFileInput && browseButton && imageInput) {
      const openPicker = () => imageFileInput.click();

      wireDropzone(dropzone, {
        onClick: openPicker,
        onFiles: async (files) => {
          const file = files[0];
          if (!file) return;
          try {
            updateDraftImagePreview(await resizeImageToDataUrl(file), file.name || 'Selected image');
            DJ.setStatus('adminStatus', 'Photo attached to the new entry.', 'success');
          } catch (error) {
            DJ.setStatus('adminStatus', error.message || 'Unable to use that image.', 'error');
          }
        }
      });

      browseButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openPicker();
      });

      imageFileInput.addEventListener('change', async () => {
        const file = imageFileInput.files?.[0];
        if (!file) return;
        try {
          updateDraftImagePreview(await resizeImageToDataUrl(file), file.name || 'Selected image');
          DJ.setStatus('adminStatus', 'Photo attached to the new entry.', 'success');
        } catch (error) {
          DJ.setStatus('adminStatus', error.message || 'Unable to use that image.', 'error');
        }
      });

      imageInput.addEventListener('input', () => {
        const value = imageInput.value.trim();
        if (value) updateDraftImagePreview(value, value.startsWith('data:image') ? 'Uploaded image' : 'Image URL preview');
        else clearDraftImage();
      });

      removeButton?.addEventListener('click', () => {
        clearDraftImage();
        DJ.setStatus('adminStatus', 'Image cleared from the draft entry.', 'info');
      });
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      DJ.setStatus('adminStatus');

      const image = form.image.value.trim();
      const category = form.category.value.trim() || 'Other';
      const item = {
        id: Date.now(),
        name: form.name.value.trim(),
        category,
        team: form.team.value.trim(),
        year: Number(form.year.value),
        condition: form.condition.value.trim(),
        price: Number(form.price.value),
        image: image || DJ.fallbackByCategory[category] || DJ.fallbackByCategory.Other,
        description: form.description.value.trim()
      };

      if (!(item.name && item.category && Number.isFinite(item.year) && Number.isFinite(item.price))) {
        DJ.setStatus('adminStatus', 'Please complete the required fields: name, category, year, and price.', 'error');
        form.querySelector('[required]')?.focus();
        return;
      }

      const customProducts = DJ.getCustomProducts();
      customProducts.unshift(item);
      if (DJ.saveCustomProducts(customProducts)) {
        form.reset();
        clearDraftImage();
        renderCustomItems();
        DJ.setStatus('adminStatus', 'Item added successfully. It now appears in the shop views on this browser.', 'success');
      } else {
        DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Existing listing editor helpers
  // ---------------------------------------------------------------------------

  async function loadBaseProducts() {
    if (existingState.baseProducts.length) return existingState.baseProducts;

    if (!baseProductsPromise) {
      baseProductsPromise = (async () => {
        const preloaded = typeof DJ.getPreloadedProductsForSource === 'function'
          ? DJ.getPreloadedProductsForSource('products.json')
          : null;

        if (preloaded) {
          existingState.baseProducts = preloaded;
          return existingState.baseProducts;
        }

        if (window.location.protocol === 'file:' && typeof DJ.loadPreloadedProductsForSource === 'function') {
          const localBundleProducts = await DJ.loadPreloadedProductsForSource('products.json').catch(() => null);
          if (localBundleProducts) {
            existingState.baseProducts = localBundleProducts;
            return existingState.baseProducts;
          }
        }

        const response = await fetch('products.json', { cache: 'force-cache' });
        if (!response.ok) {
          throw new Error(`Failed to load products.json (${response.status})`);
        }

        const products = await response.json();
        existingState.baseProducts = Array.isArray(products) ? products : [];
        return existingState.baseProducts;
      })().catch((error) => {
        baseProductsPromise = null;
        throw error;
      });
    }

    return baseProductsPromise;
  }

  function reportExistingListingsLoadError(error) {
    console.error(error);
    DJ.setStatus('adminStatus', 'Existing listings could not be loaded for editing right now.', 'error');
    const count = document.getElementById('existingListingsCount');
    if (count) count.textContent = 'Existing listings could not be loaded.';
  }

  function requestExistingListingsLoad() {
    if (existingListingsReadyPromise) {
      return existingListingsReadyPromise;
    }

    // Treat the static catalog load like a singleton bootstrap task so search,
    // edit, and restore flows all wait on the same in-flight work instead of
    // kicking off overlapping requests and duplicate editor setup.
    const count = document.getElementById('existingListingsCount');
    if (count && !existingState.baseProducts.length) {
      count.textContent = 'Loading listings...';
    }

    existingListingsReadyPromise = (async () => {
      await loadBaseProducts();

      if (!existingEditorInitialized) {
        initExistingListingEditor();
        existingEditorInitialized = true;
      }

      renderExistingListings();
    })().catch((error) => {
      existingListingsReadyPromise = null;
      reportExistingListingsLoadError(error);
      throw error;
    });

    return existingListingsReadyPromise;
  }

  function getProductOverride(productId) {
    const overrides = DJ.getProductOverrides();
    return overrides[String(productId)] || {};
  }

  function mergeProductWithOverride(product, override = {}) {
    const merged = { ...product, ...override };

    if (Object.prototype.hasOwnProperty.call(override, 'image')) {
      merged.image = override.image;
    }

    if (Object.prototype.hasOwnProperty.call(override, 'imageGallery')) {
      merged.imageGallery = Array.isArray(override.imageGallery) ? override.imageGallery : [];
    }

    return merged;
  }

  function getEffectiveBaseProducts() {
    return DJ.applyStoredCatalogMutations(existingState.baseProducts, { includeCustomProducts: false });
  }

  function getDeletedBaseProducts() {
    const deletedIds = new Set(DJ.getDeletedProductIds().map((item) => Number(item)));
    return existingState.baseProducts.filter((product) => deletedIds.has(Number(product.id)));
  }

  /**
   * Save a partial override for a base product. The storefront later merges this
   * object over the original product data so edits stay non-destructive.
   */
  function saveProductOverride(productId, patch) {
    const overrides = DJ.getProductOverrides();
    const key = String(productId);
    overrides[key] = {
      ...(overrides[key] || {}),
      ...patch
    };
    return DJ.saveProductOverrides(overrides);
  }

  function resetProductOverride(productId) {
    const overrides = DJ.getProductOverrides();
    delete overrides[String(productId)];
    return DJ.saveProductOverrides(overrides);
  }

  function addDeletedProductId(productId) {
    const deletedIds = [...new Set(
      [...DJ.getDeletedProductIds(), Number(productId)]
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
    )];
    return DJ.saveDeletedProductIds(deletedIds);
  }

  function removeDeletedProductId(productId) {
    return DJ.saveDeletedProductIds(DJ.getDeletedProductIds().filter((item) => Number(item) !== Number(productId)));
  }

  function exportStorefrontEdits() {
    exportJsonFile({
      exportedAt: new Date().toISOString(),
      productOverrides: DJ.getProductOverrides(),
      deletedProductIds: DJ.getDeletedProductIds()
    }, 'dj-storefront-edits');
  }

  async function importStorefrontEdits(file) {
    // Storefront edit exports are intentionally forgiving: missing sections fall
    // back to empty objects/arrays so partial exports can still be restored.
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('That file did not contain storefront edit data.');
    }

    const nextOverrides = parsed.productOverrides && typeof parsed.productOverrides === 'object' && !Array.isArray(parsed.productOverrides)
      ? parsed.productOverrides
      : {};
    const nextDeletedIds = Array.isArray(parsed.deletedProductIds)
      ? parsed.deletedProductIds
      : [];

    if (!DJ.saveProductOverrides(nextOverrides) || !DJ.saveDeletedProductIds(nextDeletedIds)) {
      throw new Error(getStorageFailureMessage());
    }
  }

  // ---------------------------------------------------------------------------
  // Existing listing image and gallery management
  // ---------------------------------------------------------------------------

  function isValidHttpUrl(value = '') {
    try {
      const url = new URL(String(value || '').trim());
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  }

  function isLikelyImageReference(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) return false;
    if (/^data:image\//i.test(normalized)) return true;
    if (/^blob:/i.test(normalized)) return true;
    if (/^https?:\/\/.+\.(avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(normalized)) return true;
    if (/^https?:\/\//i.test(normalized)) return true;
    if (/^assets\//i.test(normalized)) return true;
    if (/^[./A-Za-z0-9 _-]+?\.(avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(normalized)) return true;
    return false;
  }

  function buildExistingImageAlt(product = {}, index = null) {
    const name = String(product?.name || '').trim();
    const category = String(product?.category || 'Other').trim() || 'Other';
    if (name && Number.isFinite(index)) {
      return `${name} gallery image ${index + 1}`;
    }
    if (name) {
      return `${name} product image`;
    }
    if (Number.isFinite(index)) {
      return `${category} gallery image ${index + 1}`;
    }
    return `${category} product image preview`;
  }

  function renderMainImagePreview(imageUrl, product) {
    const wrap = document.getElementById('existingMainImagePreviewWrap');
    const image = document.getElementById('existingMainImagePreview');
    const name = document.getElementById('existingMainImageName');
    if (!wrap || !image || !name) return;

    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const source = imageUrl || fallback;
    image.src = DJ.safeAssetUrl(source);
    image.setAttribute('data-fallback-src', DJ.safeAssetUrl(fallback));
    image.alt = buildExistingImageAlt(product);
    name.textContent = imageUrl ? `Main photo ready for ${product.name || 'listing'}` : 'Using category placeholder';
    wrap.hidden = false;
    DJ.applyLazyLoading(wrap);
  }

  function renderGalleryEditor() {
    const galleryList = document.getElementById('existingGalleryList');
    if (!galleryList) return;
    const currentMain = document.getElementById('existingImage')?.value.trim() || '';
    const product = getCurrentEditingProduct() || {
      name: document.getElementById('existingName')?.value.trim() || '',
      category: document.getElementById('existingCategory')?.value || 'Other'
    };

    if (!existingState.currentGallery.length) {
      galleryList.innerHTML = `
        <div class="empty-state compact-empty-state">
          <h3>No gallery photos yet</h3>
          <p>Add URLs or upload photos to build out the storefront gallery for this local override.</p>
        </div>
      `;
      return;
    }

    galleryList.innerHTML = existingState.currentGallery.map((imageUrl, index) => `
      <div class="admin-gallery-item${currentMain === imageUrl ? ' is-main' : ''}" data-gallery-index="${index}">
        <img src="${DJ.escapeHtml(DJ.safeAssetUrl(imageUrl))}" alt="${DJ.escapeHtml(buildExistingImageAlt(product, index))}">
        <div class="admin-gallery-item__body">
          <div class="admin-gallery-item__copy">
            <strong>Photo ${index + 1}${currentMain === imageUrl ? ' - Main photo' : ''}</strong>
            <p class="helper-text">${currentMain === imageUrl ? 'Used on the product card and shown first in the gallery.' : 'Saved in the local gallery draft for this listing.'}</p>
          </div>
          <div class="admin-gallery-item__actions">
            <button type="button" class="button-secondary" data-gallery-action="set-main" data-gallery-index="${index}">Set as Main</button>
            <button type="button" class="button-ghost" data-gallery-action="remove" data-gallery-index="${index}">Remove</button>
          </div>
        </div>
      </div>
    `).join('');

    DJ.applyLazyLoading(galleryList);
  }

  function getCurrentEditingProduct() {
    if (!existingState.editingId) return null;
    return getEffectiveBaseProducts().find((product) => Number(product.id) === Number(existingState.editingId)) || null;
  }

  function highlightExistingListingSelection() {
    document.getElementById('existingListingsList')?.querySelectorAll('[data-existing-id]').forEach((card) => {
      const isSelected = Number(card.getAttribute('data-existing-id')) === Number(existingState.editingId);
      card.classList.toggle('is-selected', isSelected);
      card.setAttribute('aria-current', isSelected ? 'true' : 'false');
    });
  }

  function populateExistingListingForm(productId) {
    const product = getEffectiveBaseProducts().find((item) => Number(item.id) === Number(productId));
    if (!product) return;

    existingState.editingId = Number(productId);
    existingState.currentGallery = Array.isArray(product.imageGallery) ? [...product.imageGallery] : [];

    document.getElementById('existingProductId').value = String(product.id);
    document.getElementById('existingName').value = product.name || '';
    document.getElementById('existingCategory').value = product.category || 'Other';
    document.getElementById('existingTeam').value = product.team || '';
    document.getElementById('existingYear').value = product.year || '';
    document.getElementById('existingCondition').value = product.condition || '';
    document.getElementById('existingPrice').value = product.price ?? '';
    document.getElementById('existingPriceLabel').value = product.priceLabel || '';
    document.getElementById('existingPhotoHostPageUrl').value = product.photoHostPageUrl || '';
    document.getElementById('existingImage').value = product.image || '';
    document.getElementById('existingDescription').value = product.description || '';

    document.getElementById('existingEditorEmpty').hidden = true;
    document.getElementById('existingListingForm').hidden = false;
    renderMainImagePreview(product.image || '', product);
    renderGalleryEditor();
    highlightExistingListingSelection();

    // Keep the editor fixed in place on desktop instead of pulling the entire
    // page around whenever a listing is selected from the left column.
    if (window.innerWidth <= 900) {
      const editorPanel = document.querySelector('.admin-editor-panel');
      editorPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.getElementById('existingName').focus();
  }

  function clearExistingListingEditor(message = '') {
    existingState.editingId = null;
    existingState.currentGallery = [];
    const form = document.getElementById('existingListingForm');
    const empty = document.getElementById('existingEditorEmpty');
    const previewWrap = document.getElementById('existingMainImagePreviewWrap');
    const galleryList = document.getElementById('existingGalleryList');

    if (form) {
      form.hidden = true;
      form.reset();
    }
    if (empty) {
      empty.hidden = false;
      empty.textContent = message || 'Choose a listing from the left to edit its details, photos, or gallery.';
    }
    if (previewWrap) previewWrap.hidden = true;
    if (galleryList) galleryList.innerHTML = '';
    highlightExistingListingSelection();
  }

  function renderExistingListingCard(product) {
    const galleryCount = Array.isArray(product.imageGallery) ? product.imageGallery.length : 0;
    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const isSelected = Number(existingState.editingId) === Number(product.id);
    return `
      <article class="custom-item-card custom-item-card--editable admin-listing-card${isSelected ? ' is-selected' : ''}" data-existing-id="${product.id}" aria-current="${isSelected ? 'true' : 'false'}">
        <div class="custom-item-media">
          <img src="${DJ.escapeHtml(DJ.safeAssetUrl(product.image || fallback))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(fallback))}" alt="${DJ.escapeHtml(product.name)}">
        </div>
        <div class="admin-card-copy">
          <div class="admin-card-pills">
            <span class="admin-card-pill">${DJ.escapeHtml(product.category || 'Other')}</span>
          </div>
          <h4>${DJ.escapeHtml(product.name)}</h4>
          <p>${DJ.escapeHtml(String(product.year || 'Year not listed'))} | ${DJ.escapeHtml(product.category || 'Other')}</p>
          <p>${DJ.escapeHtml(product.team || 'No team / publisher listed')}</p>
          <p>${DJ.escapeHtml(DJ.displayPrice(product))} | ${DJ.escapeHtml(product.condition || 'Condition not listed')}</p>
          <p class="helper-text">Gallery photos: ${galleryCount}</p>
          <div class="inline-actions compact">
            <button type="button" data-existing-action="edit" data-existing-id="${product.id}">Open Editor</button>
            <button type="button" class="button-secondary" data-existing-action="replace-main" data-existing-id="${product.id}">Replace Main Photo</button>
            <button type="button" class="button-secondary" data-existing-action="remove-main" data-existing-id="${product.id}">Remove Main Photo</button>
            <button type="button" class="button-ghost" data-existing-action="hide" data-existing-id="${product.id}">Delete from Storefront</button>
          </div>
          <input accept="image/*" class="sr-only" data-existing-main-input="${product.id}" type="file">
        </div>
      </article>
    `;
  }

  function getFilteredExistingProducts() {
    const products = getEffectiveBaseProducts();
    const search = existingState.search.trim().toLowerCase();
    const sorted = [...products].sort((left, right) => left.name.localeCompare(right.name));
    const selectedId = Number(existingState.editingId);

    const fullList = !search
      ? sorted
      : sorted.filter((product) => [
          product.name,
          product.team,
          product.category,
          product.description,
          product.playerAthlete,
          product.year,
          product.condition
        ].join(' ').toLowerCase().includes(search));

    let visible = fullList.slice(0, MAX_EXISTING_RESULTS);

    if (selectedId) {
      const selectedProduct = fullList.find((product) => Number(product.id) === selectedId);
      const selectedVisible = visible.some((product) => Number(product.id) === selectedId);
      if (selectedProduct && !selectedVisible) {
        visible = [selectedProduct, ...visible.slice(0, Math.max(0, MAX_EXISTING_RESULTS - 1))];
      }
    }

    return {
      products: visible,
      total: fullList.length,
      limited: fullList.length > MAX_EXISTING_RESULTS
    };
  }

  function renderHiddenListings() {
    const container = document.getElementById('hiddenListingsList');
    if (!container) return;

    const hiddenProducts = getDeletedBaseProducts().sort((left, right) => left.name.localeCompare(right.name));
    if (!hiddenProducts.length) {
      container.innerHTML = `
        <div class="empty-state compact-empty-state">
          <p>No hidden base listings.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = hiddenProducts.map((product) => `
      <div class="custom-item-card custom-item-card--compact">
        <div>
          <h4>${DJ.escapeHtml(product.name)}</h4>
          <p>${DJ.escapeHtml(String(product.year || 'Year not listed'))} | ${DJ.escapeHtml(product.category || 'Other')}</p>
        </div>
        <button type="button" class="button-secondary" data-restore-id="${product.id}">Restore</button>
      </div>
    `).join('');
  }

  async function quickReplaceMainPhoto(productId, file) {
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      if (!saveProductOverride(productId, { image: dataUrl })) {
        throw new Error(getStorageFailureMessage());
      }
      DJ.setStatus('adminStatus', 'Main photo updated.', 'success');
      renderExistingListings();
      if (Number(existingState.editingId) === Number(productId)) {
        populateExistingListingForm(productId);
      }
    } catch (error) {
      DJ.setStatus('adminStatus', error.message || 'Unable to replace the main photo.', 'error');
    }
  }

  function removeMainPhoto(productId) {
    if (saveProductOverride(productId, { image: '' })) {
      DJ.setStatus('adminStatus', 'Main photo removed. The category placeholder will be used.', 'success');
      renderExistingListings();
      if (Number(existingState.editingId) === Number(productId)) {
        populateExistingListingForm(productId);
      }
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function hideExistingListing(productId) {
    if (!window.confirm('Delete this listing from the storefront on this browser? This will not remove it from the source JSON file.')) {
      return;
    }

    if (addDeletedProductId(productId)) {
      DJ.setStatus('adminStatus', 'Listing removed from the storefront on this browser.', 'success');
      if (Number(existingState.editingId) === Number(productId)) {
        clearExistingListingEditor('That listing is currently hidden from the storefront. Restore it below to edit it again.');
      }
      renderExistingListings();
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function renderExistingListings() {
    const container = document.getElementById('existingListingsList');
    const count = document.getElementById('existingListingsCount');
    if (!container) return;

    const { products, total, limited } = getFilteredExistingProducts();
    updateSearchShellState('existingListingSearch', 'existingListingSearchShell');

    if (count) {
      count.textContent = limited
        ? `Showing ${products.length} of ${total} listings. Refine the search to narrow the results.`
        : `${formatCountLabel(total, 'listing')} available to edit on this browser.`;
    }

    if (!products.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No listings matched</h3>
          <p>Try a broader search to find the product you want to edit.</p>
        </div>
      `;
      renderHiddenListings();
      return;
    }

    container.innerHTML = products.map(renderExistingListingCard).join('');

    DJ.applyLazyLoading(container);
    highlightExistingListingSelection();
    renderHiddenListings();
  }

  async function addGalleryImageFromFile(file) {
    const dataUrl = await resizeImageToDataUrl(file);
    existingState.currentGallery.push(dataUrl);
    renderGalleryEditor();
  }

  function bindExistingListingInteractions() {
    const galleryList = document.getElementById('existingGalleryList');
    if (galleryList && galleryList.dataset.bound !== 'true') {
      galleryList.dataset.bound = 'true';
      galleryList.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('[data-gallery-action]');
        if (!button) return;

        const index = Number(button.dataset.galleryIndex);
        if (!Number.isFinite(index)) return;

        if (button.dataset.galleryAction === 'remove') {
          existingState.currentGallery.splice(index, 1);
          renderGalleryEditor();
          return;
        }

        if (button.dataset.galleryAction === 'set-main') {
          const imageInput = document.getElementById('existingImage');
          const product = getCurrentEditingProduct();
          if (!imageInput || !product) return;
          imageInput.value = existingState.currentGallery[index] || '';
          renderMainImagePreview(imageInput.value.trim(), product);
          renderGalleryEditor();
        }
      });
    }

    const hiddenListings = document.getElementById('hiddenListingsList');
    if (hiddenListings && hiddenListings.dataset.bound !== 'true') {
      hiddenListings.dataset.bound = 'true';
      hiddenListings.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('[data-restore-id]');
        if (!button) return;

        if (removeDeletedProductId(button.dataset.restoreId)) {
          DJ.setStatus('adminStatus', 'Listing restored to the storefront.', 'success');
          renderExistingListings();
        } else {
          DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
        }
      });
    }

    const listings = document.getElementById('existingListingsList');
    if (listings && listings.dataset.bound !== 'true') {
      listings.dataset.bound = 'true';
      listings.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const actionButton = event.target.closest('[data-existing-action]');
        if (actionButton) {
          const productId = actionButton.dataset.existingId;
          if (!productId) return;

          if (actionButton.dataset.existingAction === 'edit') {
            populateExistingListingForm(productId);
            return;
          }

          if (actionButton.dataset.existingAction === 'replace-main') {
            listings.querySelector(`[data-existing-main-input="${productId}"]`)?.click();
            return;
          }

          if (actionButton.dataset.existingAction === 'remove-main') {
            removeMainPhoto(productId);
            return;
          }

          if (actionButton.dataset.existingAction === 'hide') {
            hideExistingListing(productId);
            return;
          }
        }

        const card = event.target.closest('[data-existing-id]');
        if (!card || event.target.closest('button, input, label, a')) {
          return;
        }

        populateExistingListingForm(card.getAttribute('data-existing-id'));
      });

      listings.addEventListener('change', (event) => {
        if (!(event.target instanceof Element)) return;
        const input = event.target.closest('[data-existing-main-input]');
        if (!input) return;
        const file = input.files?.[0];
        if (file) quickReplaceMainPhoto(input.getAttribute('data-existing-main-input'), file);
        input.value = '';
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Existing listing editor wiring
  // ---------------------------------------------------------------------------

  function initExistingListingEditor() {
    const searchInput = document.getElementById('existingListingSearch');
    const clearSearchButton = document.getElementById('existingListingSearchClear');
    const form = document.getElementById('existingListingForm');
    const replaceMainInput = document.getElementById('existingReplaceMainPhotoInput');
    const replaceMainButton = document.getElementById('existingReplaceMainPhotoButton');
    const removeMainButton = document.getElementById('existingRemoveMainPhotoButton');
    const hideButton = document.getElementById('existingHideListingButton');
    const resetButton = document.getElementById('existingResetOverrideButton');
    const imageInput = document.getElementById('existingImage');
    const addGalleryUrlButton = document.getElementById('existingAddGalleryUrlButton');
    const addGalleryFileButton = document.getElementById('existingAddGalleryFileButton');
    const galleryUrlInput = document.getElementById('existingGalleryUrl');
    const galleryFileInput = document.getElementById('existingGalleryFileInput');
    const exportEditsButton = document.getElementById('exportStorefrontEdits');
    const importEditsButton = document.getElementById('importStorefrontEditsButton');
    const importEditsInput = document.getElementById('importStorefrontEditsInput');

    bindExistingListingInteractions();

    searchInput?.addEventListener('input', () => {
      existingState.search = searchInput.value;
      renderExistingListings();
    });

    clearSearchButton?.addEventListener('click', () => {
      if (!searchInput || !searchInput.value) return;
      searchInput.value = '';
      existingState.search = '';
      renderExistingListings();
      DJ.setStatus('adminStatus', 'Existing listing search cleared.', 'info');
    });

    searchInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!searchInput.value) return;
      event.preventDefault();
      searchInput.value = '';
      existingState.search = '';
      renderExistingListings();
      DJ.setStatus('adminStatus', 'Existing listing search cleared.', 'info');
    });

    exportEditsButton?.addEventListener('click', () => {
      exportStorefrontEdits();
      DJ.setStatus('adminStatus', 'Storefront edits exported.', 'success');
    });

    importEditsButton?.addEventListener('click', () => importEditsInput?.click());
    importEditsInput?.addEventListener('change', async () => {
      const file = importEditsInput.files?.[0];
      if (!file) return;

      try {
        await importStorefrontEdits(file);
        DJ.setStatus('adminStatus', 'Storefront edits imported.', 'success');
        renderExistingListings();
        if (existingState.editingId) {
          const stillVisible = getEffectiveBaseProducts().some((product) => Number(product.id) === Number(existingState.editingId));
          if (stillVisible) {
            populateExistingListingForm(existingState.editingId);
          } else {
            clearExistingListingEditor('The current listing is hidden from the storefront. Restore it below to edit it again.');
          }
        }
      } catch (error) {
        DJ.setStatus('adminStatus', error.message || 'Unable to import storefront edits.', 'error');
      } finally {
        importEditsInput.value = '';
      }
    });

    imageInput?.addEventListener('input', () => {
      const product = getCurrentEditingProduct();
      if (!product) return;
      renderMainImagePreview(imageInput.value.trim(), { ...product, category: document.getElementById('existingCategory').value || product.category });
      renderGalleryEditor();
    });

    replaceMainButton?.addEventListener('click', () => replaceMainInput?.click());
    replaceMainInput?.addEventListener('change', async () => {
      const file = replaceMainInput.files?.[0];
      const product = getCurrentEditingProduct();
      if (!file || !product) return;
      try {
        imageInput.value = await resizeImageToDataUrl(file);
        renderMainImagePreview(imageInput.value, product);
        renderGalleryEditor();
        DJ.setStatus('adminStatus', 'Main photo ready to save.', 'success');
      } catch (error) {
        DJ.setStatus('adminStatus', error.message || 'Unable to use that image.', 'error');
      } finally {
        replaceMainInput.value = '';
      }
    });

    removeMainButton?.addEventListener('click', () => {
      const product = getCurrentEditingProduct();
      if (!product || !imageInput) return;
      imageInput.value = '';
      renderMainImagePreview('', { ...product, category: document.getElementById('existingCategory').value || product.category });
      renderGalleryEditor();
      DJ.setStatus('adminStatus', 'Main photo removed. Save changes to apply the placeholder image.', 'info');
    });

    hideButton?.addEventListener('click', () => {
      const productId = document.getElementById('existingProductId').value;
      if (productId) hideExistingListing(productId);
    });

    resetButton?.addEventListener('click', () => {
      const productId = document.getElementById('existingProductId').value;
      if (!productId) return;
      if (!window.confirm('Reset all browser-saved changes for this listing?')) return;

      if (resetProductOverride(productId)) {
        DJ.setStatus('adminStatus', 'Listing changes were reset to the source data.', 'success');
        populateExistingListingForm(productId);
        renderExistingListings();
      } else {
        DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
      }
    });

    addGalleryUrlButton?.addEventListener('click', () => {
      const value = galleryUrlInput?.value.trim();
      if (!value) return;
      if (!isLikelyImageReference(value)) {
        DJ.setStatus('adminStatus', 'Gallery image URLs should point to an image file, uploaded asset, or direct image address.', 'error');
        galleryUrlInput?.focus();
        return;
      }
      existingState.currentGallery.push(value);
      galleryUrlInput.value = '';
      renderGalleryEditor();
      DJ.setStatus('adminStatus', 'Gallery image added. Save changes to apply it.', 'success');
    });

    addGalleryFileButton?.addEventListener('click', () => galleryFileInput?.click());
    galleryFileInput?.addEventListener('change', async () => {
      const file = galleryFileInput.files?.[0];
      if (!file) return;
      try {
        await addGalleryImageFromFile(file);
        DJ.setStatus('adminStatus', 'Gallery image added. Save changes to apply it.', 'success');
      } catch (error) {
        DJ.setStatus('adminStatus', error.message || 'Unable to add that gallery image.', 'error');
      } finally {
        galleryFileInput.value = '';
      }
    });

    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const productId = Number(document.getElementById('existingProductId').value);
      if (!Number.isFinite(productId)) return;

      const yearInput = document.getElementById('existingYear');
      const priceInput = document.getElementById('existingPrice');
      const patch = {
        name: document.getElementById('existingName').value.trim(),
        category: document.getElementById('existingCategory').value.trim() || 'Other',
        team: document.getElementById('existingTeam').value.trim(),
        year: yearInput.value === '' ? null : Number(yearInput.value),
        condition: document.getElementById('existingCondition').value.trim(),
        price: priceInput.value === '' ? null : Number(priceInput.value),
        priceLabel: document.getElementById('existingPriceLabel').value.trim(),
        photoHostPageUrl: document.getElementById('existingPhotoHostPageUrl').value.trim(),
        image: document.getElementById('existingImage').value.trim(),
        description: document.getElementById('existingDescription').value.trim(),
        imageGallery: [...existingState.currentGallery]
      };

      if (!patch.name) {
        DJ.setStatus('adminStatus', 'Name is required for an existing listing.', 'error');
        document.getElementById('existingName').focus();
        return;
      }

      if (document.getElementById('existingYear').value && !Number.isFinite(patch.year)) {
        DJ.setStatus('adminStatus', 'Year must be a valid number.', 'error');
        document.getElementById('existingYear').focus();
        return;
      }

      if (document.getElementById('existingPrice').value && !Number.isFinite(patch.price)) {
        DJ.setStatus('adminStatus', 'Price must be a valid number.', 'error');
        document.getElementById('existingPrice').focus();
        return;
      }
      if (patch.image && !isLikelyImageReference(patch.image)) {
        DJ.setStatus('adminStatus', 'Main image should be an uploaded image URL, an assets path, or a direct image link.', 'error');
        document.getElementById('existingImage').focus();
        return;
      }
      if (patch.photoHostPageUrl && !isValidHttpUrl(patch.photoHostPageUrl)) {
        DJ.setStatus('adminStatus', 'Photo host URL must start with http:// or https://.', 'error');
        document.getElementById('existingPhotoHostPageUrl').focus();
        return;
      }

      if (saveProductOverride(productId, patch)) {
        DJ.setStatus('adminStatus', 'Listing updated successfully on this browser.', 'success');
        renderExistingListings();
        populateExistingListingForm(productId);
      } else {
        DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
      }
    });
  }

  document.addEventListener('dj:local-admin-visibility', (event) => {
    if (event.detail?.visible) {
      requestExistingListingsLoad().catch(() => {});
    }
  });

  // Boot the local admin panels after the page and shared DJ helpers are ready.
  document.addEventListener('DOMContentLoaded', () => {
    initNewItemForm();
    initCustomProductsPanel();
    bindCustomItemInteractions();
    renderCustomItems();

    if (!DJ.remoteCatalog?.isConfigured?.()) {
      requestExistingListingsLoad().catch(() => {});
    }
  });

  window.deleteCustomItem = deleteCustomProduct;
})();
