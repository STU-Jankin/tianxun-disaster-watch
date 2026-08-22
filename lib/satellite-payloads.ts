export type SarLookSide = "left" | "right";
export type SarPayloadType = "CSAR" | "XSAR";
export type PayloadParameterStatus = "user_provided" | "provisional_assumption";

export type SarImagingMode = {
  id: "spotlight" | "stripmap" | "topsar" | "scan_es";
  name: string;
  resolutionM: number;
  nominalSceneCrossTrackKm: number;
  nominalSceneAlongTrackKm: number;
  footprintSemantics: "nominal_scene_unverified";
};

export type SarPayloadProfile = {
  id: string;
  payloadType: SarPayloadType;
  frequencyBand: "C" | "X";
  lookSides: readonly SarLookSide[];
  incidenceAngleDeg: { min: number; max: number };
  imagingModes: readonly SarImagingMode[];
  parameterStatus: PayloadParameterStatus;
  parameterNote: string;
};

const nominalCsarModes: readonly SarImagingMode[] = [
  { id: "spotlight", name: "聚束模式", resolutionM: 1, nominalSceneCrossTrackKm: 7, nominalSceneAlongTrackKm: 7, footprintSemantics: "nominal_scene_unverified" },
  { id: "stripmap", name: "条带模式", resolutionM: 3, nominalSceneCrossTrackKm: 25, nominalSceneAlongTrackKm: 25, footprintSemantics: "nominal_scene_unverified" },
  { id: "topsar", name: "TOPSAR", resolutionM: 10, nominalSceneCrossTrackKm: 100, nominalSceneAlongTrackKm: 100, footprintSemantics: "nominal_scene_unverified" },
  { id: "scan_es", name: "扫描模式ES", resolutionM: 20, nominalSceneCrossTrackKm: 170, nominalSceneAlongTrackKm: 170, footprintSemantics: "nominal_scene_unverified" },
] as const;

export const sarPayloadProfiles: Readonly<Record<string, SarPayloadProfile>> = {
  "ty-csar-v1": {
    id: "ty-csar-v1",
    payloadType: "CSAR",
    frequencyBand: "C",
    lookSides: ["left", "right"],
    incidenceAngleDeg: { min: 15, max: 45 },
    imagingModes: nominalCsarModes,
    parameterStatus: "user_provided",
    parameterNote: "用户提供的天仪CSAR标称参数；场景尺寸暂未确认是否等同真实瞬时幅宽。",
  },
  "ty-xsar-provisional-v1": {
    id: "ty-xsar-provisional-v1",
    payloadType: "XSAR",
    frequencyBand: "X",
    lookSides: ["left", "right"],
    incidenceAngleDeg: { min: 17, max: 50 },
    imagingModes: nominalCsarModes.map((mode) => ({ ...mode })),
    parameterStatus: "provisional_assumption",
    parameterNote: "临时复用CSAR的模式、分辨率与标称场景尺寸；仅用于仿真，待XSAR实参替换。",
  },
} as const;

export function satellitePayloadProfile(profileId: string | undefined) {
  return profileId ? sarPayloadProfiles[profileId] : undefined;
}
