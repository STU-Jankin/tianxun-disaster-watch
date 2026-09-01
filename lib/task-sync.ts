const taskDraftFields = [
  "taskId", "eventId", "masterEventId", "entityKey", "hazard", "aoiType", "aoiRadiusKm", "aoiWidthKm", "aoiHeightKm", "aoiLengthKm", "aoiBearingDeg",
  "customGeometry", "minimumCoveragePercent", "maximumCloudPercent", "spatialResolutionMeters", "incidenceAngleMinDeg",
  "incidenceAngleMaxDeg", "revisitCount", "deliveryDeadline", "imagingStart", "imagingEnd", "sensors", "sarImagingModes", "observationTargets",
  "aoiApproval", "approvalReason", "createdAt", "updatedAt", "status", "revision", "eventRevision",
  "satelliteId", "instrumentId", "imagingMode", "opportunityId", "orbitVersion", "visibilityComputedAt", "incidenceAngleDeg", "offNadirAngleDeg",
  "opportunityLookSide", "opportunityCoveragePercent", "opportunitySpatialResolutionM", "opportunitySceneCrossTrackKm", "opportunitySceneAlongTrackKm", "opportunityStart", "opportunityEnd",
  "opportunityReachableNearKm", "opportunityReachableFarKm", "opportunitySceneNearEdgeKm", "opportunitySceneFarEdgeKm", "opportunityFootprintRangeMarginKm", "opportunityIncidenceConstraintSemantics", "opportunityReachableLookSides", "sensorParameterStatus", "opportunityFootprint",
  "simulationLevel", "satelliteNoradId", "closestApproachAt", "closestSubpointLatitude", "closestSubpointLongitude",
  "minimumGroundTrackDistanceKm", "orbitSearchRadiusKm", "opportunityOrbitDirection",
  "orbitDirectionPreference", "referenceAcquisitionRequired", "sarAnalysisMode", "cycloneTrackingTarget",
] as const;

/**
 * Build the untrusted operator-authored part of a task update.
 * Event evidence, source geometry and cyclone products are canonical server data
 * and must never be echoed back by the browser as an authority or a large payload.
 */
export function compactSatelliteTaskForSync(task: Record<string, unknown>) {
  return Object.fromEntries(taskDraftFields.flatMap((field) => task[field] === undefined ? [] : [[field, task[field]]]));
}
