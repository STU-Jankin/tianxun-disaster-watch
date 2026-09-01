export type SatelliteOrbitModelProfile = {
  id: "stk-sgp4-wgs72-v1";
  propagator: "SGP4";
  gravityModel: "WGS72";
  inertialFrame: "J2000";
  groundFrame: "Earth Fixed";
  timeSystem: "UTCG";
  runtimeElementPolicy: "daily_tle";
  referenceApplication: "STK 11";
  referenceStepSeconds: 60;
  referenceSamplesPerSatellite: 3001;
  validationStatus: "verified_against_stk_export";
  validationMaximumGroundDifferenceM: number;
  note: string;
};

export const satelliteOrbitModelProfiles: Readonly<Record<string, SatelliteOrbitModelProfile>> = {
  "stk-sgp4-wgs72-v1": {
    id: "stk-sgp4-wgs72-v1",
    propagator: "SGP4",
    gravityModel: "WGS72",
    inertialFrame: "J2000",
    groundFrame: "Earth Fixed",
    timeSystem: "UTCG",
    runtimeElementPolicy: "daily_tle",
    referenceApplication: "STK 11",
    referenceStepSeconds: 60,
    referenceSamplesPerSatellite: 3001,
    validationStatus: "verified_against_stk_export",
    validationMaximumGroundDifferenceM: 0.25,
    note: "运行时继续采用服务器每日更新并通过校验的TLE；STK导出的过期状态向量仅用于验证SGP4/WGS72、J2000/UTCG计算口径，不参与实时任务规划。",
  },
} as const;

export function satelliteOrbitModelProfile(profileId: string | undefined) {
  return profileId ? satelliteOrbitModelProfiles[profileId] : undefined;
}
