import { KnowledgeCluster } from "@/context/VenomContext";

export type GraphPoint = { x: number; y: number };

export type GraphCamera = { yaw: number; pitch: number; zoom: number };
export type GraphConnection = {
  id: string;
  from: KnowledgeCluster;
  to: KnowledgeCluster;
  index: number;
};

export const MAX_LIVE_CONNECTIONS = 48;

export const DEFAULT_GRAPH_CAMERA: GraphCamera = { yaw: 0, pitch: 0, zoom: 1 };
export type ProjectedGraphCluster = ProjectedGraphPoint & {
  cluster: KnowledgeCluster;
};

export const clampGraphValue = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export type ProjectedGraphPoint = GraphPoint & {
  depth: number;
  scale: number;
  opacity: number;
};

export function graphDepthForCluster(cluster: KnowledgeCluster) {
  let hash = 17;
  for (const character of cluster.id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return (hash % 210) - 105 + Math.sin(cluster.x * 0.06 + cluster.y * 0.04) * 32;
}
export function projectGraphCluster(
  cluster: KnowledgeCluster,
  camera: GraphCamera,
  baseScale: number,
  center: number,
): ProjectedGraphPoint {
  const worldX = cluster.x * 2.25;
  const worldY = cluster.y * 2.25;
  const worldZ = graphDepthForCluster(cluster);
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const afterYawX = worldX * cosYaw + worldZ * sinYaw;
  const afterYawZ = worldZ * cosYaw - worldX * sinYaw;
  const afterPitchY = worldY * cosPitch - afterYawZ * sinPitch;
  const depth = afterYawZ * cosPitch + worldY * sinPitch;
  const perspective = 700 / (700 - depth);
  const positionScale = clampGraphValue(
    baseScale * camera.zoom * perspective,
    0.28,
    1.35,
  );
  const scale = clampGraphValue(camera.zoom * perspective, 0.66, 1.45);

  return {
    x: center + afterYawX * positionScale,
    y: center + afterPitchY * positionScale,
    depth,
    scale,
    opacity: clampGraphValue(0.34 + (depth + 220) / 370, 0.34, 1),
  };
}
