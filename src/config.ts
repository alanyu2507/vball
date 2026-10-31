/**
 * All tuning values live here. Every value is exposed in the F1 tuning panel.
 * Units: meters, seconds, kilograms, radians unless a name says otherwise.
 * TIME_SCALE scales the whole simulation (sim seconds per real second).
 */
export const CONFIG = {
  sim: {
    TIME_SCALE: 0.85, // sim seconds advanced per real second; <1 makes everything slower than real life
    TICK_RATE: 60, // fixed simulation ticks per real second
  },
  court: {
    length: 16, // full court length along X (net at X=0)
    width: 8, // full court width along Z
    netHeight: 2.43, // top of the net band
    netWidth: 8.5, // net length along Z (antennas at +-4.25)
    netBottom: 0.0, // net collider extends down to this height (prevents under-net passes)
    solverNetClearance: 0.12, // hit solver requires this much clearance over the tape
    outMargin: 2.5, // how far outside the lines players may run
  },
  ball: {
    mass: 0.27,
    radius: 0.125,
    gravity: 9.81,
    airDensity: 1.225,
    dragCoeff: 0.28, // quadratic drag coefficient Cd (supercritical regime, real ball ~0.2-0.3)
    magnusCoeff: 0.0011, // Magnus force = magnusCoeff * (omega x v) [N per (rad/s * m/s)]
    spinDecay: 0.35, // fraction of spin lost per second
    groundRestitution: 0.45,
    groundFriction: 0.6, // tangential velocity kept on ground bounce
    netRestitution: 0.22, // how hot a ball comes off the net
    netTopRestitution: 0.5, // tape contact
    netDamping: 0.55, // tangential velocity kept on net contact
    knuckleStrength: 1.7, // float serve lateral acceleration scale (m/s^2)
    knuckleSpinThreshold: 6, // spin (rad/s) under which knuckling applies
    knuckleChangeInterval: 0.18, // seconds between new knuckle directions
    knuckleSpeedLow: 5, // below this the knuckle fades out again (ball nearly stopped)
    knuckleSpeedHigh: 22, // knuckle grows as speed drops below this
    bodyRestitution: 0.38, // passive body deflection
    maxSpeed: 45,
  },
  player: {
    height: 1.85,
    capsuleRadius: 0.28,
    mass: 80,
    walkSpeed: 3.6,
    sprintSpeed: 6.4,
    accel: 14, // ground acceleration toward desired velocity (sand)
    decel: 11, // ground deceleration when no input
    airControl: 0, // airborne horizontal acceleration (0: no steering in the air)
    turnRate: 10, // body facing turn speed (rad/s)
    baseJump: 0.58, // standing jump height
    maxJump: 0.95, // full approach jump height
    approachTime: 1.2, // seconds of running (walk or sprint) to reach max jump
    sprintDecay: 1.2, // approach charge lost per second when not moving (a short pause before the jump keeps most of it)
    jumpCost: 14, // stamina per jump
    jumpMomentumKeep: 0, // fraction of horizontal speed kept at takeoff (0: every jump goes straight up)
    plantHop: 1.3, // vertical speed of the penultimate-step hop (Shift+Space while sprinting)
    plantDecay: 1.6, // approach charge lost per second while Space is held in the plant
    plantBrake: 4, // horizontal speed lost per second while planted on the ground
    plantMaxHold: 1.0, // seconds after which a held plant jumps on its own
    sprintDrain: 16, // stamina per second while sprinting
    staminaRegen: 13, // stamina per second while walking or standing
    staminaMax: 100,
    lowStamina: 30, // below this, speed, jump and swing power scale down
    lowStaminaFloor: 0.6, // multiplier at zero stamina
    eyeHeight: 1.65,
    shoulderHeight: 1.45,
    standingReach: 2.25, // hand height with arm straight up, feet on ground
    sideLimitFromNet: 0.35, // players stay this far from the net plane
  },
  spike: {
    chargeTime: 0.4, // seconds to reach full charge while holding LMB in the air
    holdTime: 0.18, // seconds charge stays at full before decaying
    decayTime: 0.9, // seconds for charge to decay from full to zero after hold
    swingLead: 0.08, // seconds from release until hand reaches the ideal contact point
    reachRadius: 0.78, // hit zone radius around the ideal contact point (red outside, green top half, orange bottom half)
    halfPower: 0.5, // power of a hit taken in the bottom (orange) half of the zone
    forwardOffset: 0.5, // ideal contact point in front of the shoulder (zone covers the space in front of the face)
    sideOffset: 0.18, // ideal contact point toward the hitting side
    perfectWindow: 0.035, // |timing error| for a Perfect
    goodWindow: 0.09, // |timing error| for Good
    earlyWindow: 0.16, // beyond this early, the swing whiffs
    lateWindow: 0.14, // beyond this late, shank
    speedMin: 9, // outgoing speed at zero charge
    speedMax: 27, // outgoing speed at full charge and perfect contact
    rollSpeedMax: 17,
    rollSpin: 48, // rad/s topspin at perfect roll shot
    floatSpeedMax: 20,
    straightSpin: 14, // light topspin on a straight hit
    earlyPowerLoss: 0.6, // fraction of power lost at the edge of the early window
    earlyPitchLift: 0.35, // radians of upward aim added at max earliness
    lateErrorCone: 0.45, // radians of aim error at the edge of the late window
    distanceErrorCone: 0.3, // radians of aim error at reachRadius from the ideal point
    distancePowerLoss: 0.45, // power lost at reachRadius from the ideal point
    shankSpeedMul: 0.55,
    swerveSidespinPerRadian: 30, // rad/s of sidespin per radian of aim yaw vs body facing
    swerveDeadzone: 0.12, // radians of yaw difference before sidespin starts
    swingDuration: 0.22, // animation length of the forward swing
  },
  tip: {
    chargeTime: 0.5,
    speedMin: 4.5,
    speedMax: 10.5,
    reachRadius: 0.7,
    arcHeight: 1.2, // how far above the line of sight the arc apex goes (fraction of distance)
  },
  set: {
    chargeTime: 0.6,
    speedMin: 3,
    speedMax: 11.5,
    reachRadius: 0.8, // horizontal distance from hands that still counts
    handHeight: 1.95, // hands above feet when standing
    pitchBias: 0.6, // set pitch = aim pitch + bias (level aim gives a 34 degree set, max aim gives ~77)
    minBallHeightAboveShoulder: 0.1,
    errorPerMeter: 0.42, // radians of direction error per meter off-center
    spinPerMeter: 20, // rad/s added per meter off-center
    speedErrorPerMeter: 0.35,
    doubleThreshold: 0.55, // off-center distance (m) that gets called a double/lift
    callDoubles: true,
    bufferTime: 0.14, // early release still fires when the ball arrives within this time
  },
  bump: {
    chargeTime: 0.5,
    speedMax: 10, // player applied platform speed at full force
    restitution: 0.62, // incoming velocity kept after reflecting off the platform at full force
    softRestitution: 0.75, // fraction of restitution at zero force (soft arms absorb a little)
    bodyCarry: 0.5, // fraction of player velocity added to the ball
    platformHeight: 1.0,
    platformForward: 0.45,
    reachRadius: 0.85,
    diveReachBonus: 0.55,
    pitchBias: 0.5, // platform pitch = aim pitch + bias (aiming level gives a 45 degree platform)
    minPitch: 0.26, // platform normal can't aim lower than this (radians above horizontal)
    maxPitch: 1.5,
    errorBase: 0.03,
    errorPerSpeed: 0.035, // radians per m/s of player velocity at contact
    errorPerOffset: 0.25, // radians per meter off the ideal platform point
    bufferTime: 0.14,
    hardBallSpeed: 9.5, // incoming speed above which contact is a dig (timing based)
  },
  dig: {
    window: 0.16, // seconds before contact during which a press counts
    idealLead: 0.05, // press this long before contact for a Perfect
    perfectWindow: 0.03,
    graceAfter: 0.05, // pressing within this after body contact still partly controls it
    graceQualityCap: 0.5,
    popUp: 7.5, // vertical speed of a perfect controlled dig
    popToward: 3.5, // speed toward own court center
    popSide: 1.0,
    dampingPower: 1.4, // quality^power blends raw deflection into controlled pop
    diveSpeed: 6.2,
    diveUp: 2.2,
    diveDuration: 0.45,
    diveRecovery: 0.9,
    diveCost: 20,
    diveFriction: 6,
  },
  block: {
    chargeTime: 0.5,
    minJump: 0.25,
    maxJump: 0.85,
    handReach: 2.4, // hand height above feet with arms up
    handRadius: 0.16,
    handSpacing: 0.26, // lateral offset of each hand from the center
    restitution: 0.72,
    stuffCentrality: 0.55, // ball within this fraction of hand span counts as a clean block
    stuffDownBlend: 0.65, // how strongly a clean block steers the ball down
    toolOutward: 0.5, // how strongly edge contacts rotate the ball outward/back
    toolRestitution: 0.5,
    diveLateral: 3.6, // lateral speed for a dive block
    diveHeightMul: 0.72,
    diveHandSpread: 0.45,
    cost: 12,
    netPressPitch: 0.5, // aim pitch (radians down) that fully angles the hands down
    activeTime: 0.9, // seconds hands stay active after the block jump
  },
  serve: {
    underhandSpeedMin: 8,
    underhandSpeedMax: 14,
    floatSpeedMin: 11,
    floatSpeedMax: 19,
    floatContactHeight: 2.1,
    chargeTime: 0.6,
    tossUp: 7.6, // toss vertical speed
    tossForward: 1.5,
    serveDelay: 1.2, // seconds before serving is allowed after point reset
  },
  rules: {
    pointsToWin: 21,
    winBy: 2,
    switchEvery: 7,
    touchesPerSide: 3,
    pointPause: 2.2, // seconds the point result stays up
    sameTouchCooldown: 0.13, // seconds within which repeated contact by one player is one touch
    rallyWatchdog: 25, // seconds of untouched ball before the sim resets (safety)
  },
  bots: {
    skill: 0.8, // 0..1 overall accuracy
    aimNoise: 0.08, // radians of random aim error at skill 0 (scaled by 1-skill)
    reactionTime: 0.18, // seconds before bots react to a new ball trajectory
    jumpServeChance: 0.25,
    attackVariety: 0.5, // chance of roll/float instead of straight on a good set
    serveDelay: 0.8,
  },
  feel: {
    hitstopMin: 0.04, // real seconds of freeze on a weak spike
    hitstopMax: 0.09, // real seconds on a max power spike
    slowmoTime: 0.25, // real seconds of slow motion on perfect contacts
    slowmoScale: 0.3,
    shakeSpike: 0.25,
    shakeDig: 0.08,
    shakeBlock: 0.2,
    fovPunch: 6, // degrees of brief FOV increase on a spike
    squash: 0.35, // ball squash amount at contact
    trailLength: 18,
    sandParticles: 40,
    showContactRating: true,
    showApproachMeter: true,
  },
  camera: {
    distance: 4.6,
    height: 1.2,
    fov: 70,
    sensitivity: 0.0022,
    pitchMin: -0.9,
    pitchMax: 0.75,
    smoothing: 18,
  },
  audio: {
    masterVolume: 0.7,
    ambient: true,
  },
};

export type Config = typeof CONFIG;

/** Deep clone used to keep the defaults for the tuning panel's reset button. */
export const DEFAULT_CONFIG: Config = JSON.parse(JSON.stringify(CONFIG));

export function resetConfig(): void {
  const src: any = DEFAULT_CONFIG;
  const dst: any = CONFIG;
  for (const g of Object.keys(src)) for (const k of Object.keys(src[g])) dst[g][k] = src[g][k];
}

/** Sim dt per tick in sim seconds. */
export function simDt(): number {
  return CONFIG.sim.TIME_SCALE / CONFIG.sim.TICK_RATE;
}
