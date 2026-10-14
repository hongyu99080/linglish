/**
 * VideoBrowserScopeSync - 统一弹窗范围筛选与共享筛选状态。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VideoBrowserScopeSync = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function applyScopeSelection(rawScope, adapters) {
    var scope = rawScope === 'mine' ? 'mine' : 'all';
    var api = adapters || {};

    if (api.browserState) api.browserState.scope = scope;
    if (typeof api.setLibraryFilter === 'function') {
      api.setLibraryFilter({ scope: scope });
    }
    if (typeof api.renderVideoBrowser === 'function') {
      api.renderVideoBrowser();
    }

    return scope;
  }

  function clearScopeSelection(adapters) {
    var api = adapters || {};

    if (api.browserState) {
      api.browserState.scope = 'all';
      api.browserState.status = '';
    }
    if (typeof api.setLibraryFilter === 'function') {
      api.setLibraryFilter({
        difficulty: null,
        scene: null,
        tagId: null,
        scope: 'all'
      });
    }
    if (typeof api.renderVideoBrowser === 'function') {
      api.renderVideoBrowser();
    }
  }

  return {
    applyScopeSelection: applyScopeSelection,
    clearScopeSelection: clearScopeSelection
  };
});
