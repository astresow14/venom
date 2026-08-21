export { SLIME_VERTEX_SHADER, buildSlimeFragmentShader } from "./shader";

export {
  FULL_SLIME_CAPACITY,
  MAX_BLOBS,
  MAX_DROPS,
  MAX_LINKS,
  SLIME_CAPACITY_TIERS,
  SOFTWARE_SLIME_CAPACITY,
  capacityForBudget,
  createEmptyField,
  isSoftwareGlRenderer,
  packSlimeField,
  slimeCapacityForTierName,
  slimeUniformVectorsFor,
  type SlimeCapacity,
  type SlimeDroplet,
  type SlimeEdge,
  type SlimeField,
  type SlimeNode,
} from "./field";

export {
  createSlimeRenderer,
  type SlimeGL,
  type SlimeRenderer,
  type SlimeRendererOptions,
  type SlimeStyle,
} from "./renderer";

export {
  createAdaptiveQuality,
  type AdaptiveQuality,
  type AdaptiveQualityOptions,
} from "./quality";

export {
  createSlimeLife,
  type SlimeLife,
  type SlimeLifeFrame,
  type SlimeLifeStepOptions,
} from "./life";

export {
  HOVERED_EMPHASIS_WEIGHT,
  LINKED_EMPHASIS_SHARE,
  SELECTED_EMPHASIS_WEIGHT,
  SLIME_EMPHASIS_SWELL,
  SLIME_EMPHASIS_TIGHTEN,
  createSlimeEmphasis,
  type SlimeEmphasis,
  type SlimeEmphasisStepOptions,
  type SlimeEmphasisTargets,
} from "./emphasis";

export {
  deriveSatelliteNodes,
  layoutIslands,
  satelliteCountFor,
  type IslandLayoutOptions,
  type IslandMember,
  type SatelliteParent,
} from "./density";
