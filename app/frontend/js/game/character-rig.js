(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameCharacterRig = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const PART_ORDER = ['head', 'body', 'armL', 'armR', 'legL', 'legR'];
  const LOCKED_SCALE = 0.35;

  const SKIN = 0xffd9b0;
  const SHIRT = 0xff8a4c;
  const PANTS = 0x4aa3d9;

  const PART_DEFINITIONS = [
    { name: 'head', label: '头', size: [0.9, 0.9, 0.85], home: [0, 1.75, 0], explode: [0, 1.4, 0], color: SKIN },
    { name: 'body', label: '身体', size: [1.1, 1.25, 0.7], home: [0, 0.85, 0], explode: [0, 0, -1.2], color: SHIRT },
    { name: 'armL', label: '左臂', size: [0.3, 1.0, 0.3], home: [-0.72, 0.95, 0], explode: [-1.5, 0.3, 0], color: SKIN },
    { name: 'armR', label: '右臂', size: [0.3, 1.0, 0.3], home: [0.72, 0.95, 0], explode: [1.5, 0.3, 0], color: SKIN },
    { name: 'legL', label: '左腿', size: [0.36, 0.95, 0.36], home: [-0.28, -0.05, 0], explode: [-0.9, -1.1, 0], color: PANTS },
    { name: 'legR', label: '右腿', size: [0.36, 0.95, 0.36], home: [0.28, -0.05, 0], explode: [0.9, -1.1, 0], color: PANTS },
  ];

  function getPartDefinitions() {
    return PART_DEFINITIONS.map(function (part) {
      return { ...part, size: part.size.slice(), home: part.home.slice(), explode: part.explode.slice() };
    });
  }

  function partForChapter(chapter) {
    const index = Number(chapter) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= PART_ORDER.length) return null;
    return PART_ORDER[index];
  }

  function computePartTransform(partDef, isUnlocked) {
    if (isUnlocked) {
      return { position: partDef.home.slice(), scale: 1, saturation: 1 };
    }
    return {
      position: [
        partDef.home[0] + partDef.explode[0],
        partDef.home[1] + partDef.explode[1],
        partDef.home[2] + partDef.explode[2],
      ],
      scale: LOCKED_SCALE,
      saturation: 0,
    };
  }

  function isCharacterComplete(unlockedParts) {
    const owned = new Set(Array.isArray(unlockedParts) ? unlockedParts : []);
    return PART_ORDER.every(function (name) { return owned.has(name); });
  }

  return {
    PART_ORDER,
    getPartDefinitions,
    partForChapter,
    computePartTransform,
    isCharacterComplete,
    LOCKED_SCALE,
  };
});
