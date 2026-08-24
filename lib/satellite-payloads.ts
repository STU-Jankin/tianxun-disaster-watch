export type SarLookSide = "left" | "right";
export type SarPayloadType = "CSAR" | "XSAR";
export type PayloadParameterStatus = "user_provided" | "provisional_assumption";

export const sarImagingModeOptions = [
  { id: "spotlight", label: "聚束模式" },
  { id: "stripmap", label: "条带模式" },
  { id: "tops_1", label: "TOPS 1" },
  { id: "tops_2", label: "TOPS 2" },
] as const;

export type SarImagingModeId = (typeof sarImagingModeOptions)[number]["id"];

export type SarImagingMode = {
  id: SarImagingModeId;
  name: string;
  /** Conservative scalar used by the task constraint filter. */
  resolutionM: number;
  /** Operator-facing value, preserving non-square resolution such as 1 m x 0.5 m. */
  resolutionLabel: string;
  resolutionDimensionsM?: readonly [number, number];
  nominalSceneCrossTrackKm: number;
  nominalSceneAlongTrackKm: number;
  footprintSemantics: "nominal_scene_unverified";
};

export type SarProductLevel = {
  level: "L1" | "L2";
  code: "SLC" | "ORG";
  name: string;
};

export type SarPayloadProfile = {
  id: string;
  payloadType: SarPayloadType;
  frequencyBand: "C" | "X";
  lookSides: readonly SarLookSide[];
  incidenceAngleDeg: { min: number; max: number };
  polarizations: readonly string[];
  productLevels: readonly SarProductLevel[];
  imagingModes: readonly SarImagingMode[];
  parameterStatus: PayloadParameterStatus;
  parameterNote: string;
};

const nominalCsarModes: readonly SarImagingMode[] = [
  { id: "spotlight", name: "聚束模式", resolutionM: 1, resolutionLabel: "1×0.5 m", resolutionDimensionsM: [1, 0.5], nominalSceneCrossTrackKm: 7, nominalSceneAlongTrackKm: 7, footprintSemantics: "nominal_scene_unverified" },
  { id: "stripmap", name: "条带模式", resolutionM: 3, resolutionLabel: "3 m", nominalSceneCrossTrackKm: 25, nominalSceneAlongTrackKm: 25, footprintSemantics: "nominal_scene_unverified" },
  { id: "tops_1", name: "TOPS 1", resolutionM: 10, resolutionLabel: "10 m", nominalSceneCrossTrackKm: 100, nominalSceneAlongTrackKm: 100, footprintSemantics: "nominal_scene_unverified" },
  { id: "tops_2", name: "TOPS 2", resolutionM: 20, resolutionLabel: "20 m", nominalSceneCrossTrackKm: 170, nominalSceneAlongTrackKm: 170, footprintSemantics: "nominal_scene_unverified" },
] as const;

const nominalXsarModes: readonly SarImagingMode[] = [
  { id: "spotlight", name: "聚束模式", resolutionM: 0.5, resolutionLabel: "0.5 m", nominalSceneCrossTrackKm: 5, nominalSceneAlongTrackKm: 5, footprintSemantics: "nominal_scene_unverified" },
  { id: "stripmap", name: "条带模式", resolutionM: 3, resolutionLabel: "3 m", nominalSceneCrossTrackKm: 30, nominalSceneAlongTrackKm: 30, footprintSemantics: "nominal_scene_unverified" },
  { id: "tops_1", name: "TOPS 1", resolutionM: 15, resolutionLabel: "15 m", nominalSceneCrossTrackKm: 100, nominalSceneAlongTrackKm: 100, footprintSemantics: "nominal_scene_unverified" },
  { id: "tops_2", name: "TOPS 2", resolutionM: 30, resolutionLabel: "30 m", nominalSceneCrossTrackKm: 240, nominalSceneAlongTrackKm: 240, footprintSemantics: "nominal_scene_unverified" },
] as const;

export const sarPayloadProfiles: Readonly<Record<string, SarPayloadProfile>> = {
  "ty-csar-v2": {
    id: "ty-csar-v2",
    payloadType: "CSAR",
    frequencyBand: "C",
    lookSides: ["left", "right"],
    incidenceAngleDeg: { min: 15, max: 45 },
    polarizations: ["VV"],
    productLevels: [
      { level: "L1", code: "SLC", name: "斜距单视复影像" },
      { level: "L2", code: "ORG", name: "地形校正影像" },
    ],
    imagingModes: nominalCsarModes,
    parameterStatus: "user_provided",
    parameterNote: "用户提供的天仪CSAR标称参数；聚束模式按较保守的1 m参与分辨率筛选，1×0.5 m原值完整保留；场景尺寸暂未确认是否等同真实瞬时幅宽。",
  },
  "ty-xsar-v1": {
    id: "ty-xsar-v1",
    payloadType: "XSAR",
    frequencyBand: "X",
    lookSides: ["left", "right"],
    incidenceAngleDeg: { min: 17, max: 50 },
    polarizations: ["VV"],
    productLevels: [],
    imagingModes: nominalXsarModes,
    parameterStatus: "user_provided",
    parameterNote: "用户提供的天仪XSAR标称参数；原表最后一行重复标为TOPS 1，系统按模式序列暂登记为TOPS 2（30 m、240×240 km），待资料方确认；XSAR产品级别尚未提供。",
  },
} as const;

export function satellitePayloadProfile(profileId: string | undefined) {
  return profileId ? sarPayloadProfiles[profileId] : undefined;
}
