// shaders/atmosphere/fragment.glsl
precision highp float;

uniform vec3 uSunDirection;
uniform vec3 uAtmosphereDayColor;
uniform vec3 uTwilightColor;
uniform float uAtmosphereIntensity; // overall multiplier
uniform float uRayleighStrength;    // GUI-driven
uniform float uMieStrength;         // GUI-driven
uniform float uScatteringPower;     // edge power / rim (legacy)
uniform int  uDebugMode;            // 0 = normal, 1 = rayleigh only, 2 = mie only

// rim uniforms (original)
uniform vec3 uRimDayColor;
uniform vec3 uRimTwilightColor;
uniform float uRimIntensity;
uniform float uRimPower; // separate falloff power for rim

// NEW: rim gradient & halo controls
uniform float uRimStart;         // 0..1 start of rim gradient
uniform float uRimEnd;           // 0..1 end of rim gradient
uniform float uRimAltitudeBoost; // scales rim at low altitudes

uniform vec3 uHaloColor;         // separate halo tint color
uniform float uHaloIntensity;    // halo strength
uniform float uHaloThickness;    // halo start
uniform float uHaloSoftness;     // halo softness/range

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vWorldPosition;

const float PI = 3.14159265359;

// Tuned base scattering coefficients for scene-scale (earth mesh radius ~2)
const vec3 BASE_RAYLEIGH = vec3(0.0025, 0.0065, 0.014); // per-channel
const float BASE_MIE = 0.003;
const float MIE_G = 0.76;

// Atmosphere geometry in scene units
const float EARTH_R = 2.0;
const float ATMO_R  = 2.1;
const float ATMO_H  = ATMO_R - EARTH_R;

// Phase functions
float rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}
float miePhase(float cosTheta, float g) {
    float g2 = g*g;
    return (1.0 / (4.0 * PI)) * ((1.0 - g2) / pow(1.0 + g2 - 2.0*g*cosTheta, 1.5));
}

// simple normalized height -> density
float density(float hNorm) {
    // sharper falloff; tweak multiplier to control vertical distribution
    return exp(-hNorm * 4.0);
}

void main() {
    // view and normal
    vec3 viewDir = normalize(vPosition - cameraPosition); // camera -> fragment
    vec3 N = normalize(vNormal);
    vec3 worldPos = vWorldPosition;

    // height above surface, normalized [0..1]
    float height = max(0.0, length(worldPos) - EARTH_R);
    float hNorm = clamp(height / ATMO_H, 0.0, 1.0);

    // angles
    vec3 sunDir = normalize(uSunDirection);
    float cosTheta = dot(viewDir, sunDir);
    float sunDotN = dot(sunDir, N);

    // phases
    float pr = rayleighPhase(cosTheta);
    float pm = miePhase(cosTheta, MIE_G);

    // local density
    float localD = density(hNorm);

    // compute contributions
    vec3 rayleigh = BASE_RAYLEIGH * pr * uRayleighStrength;
    vec3 mie = vec3(BASE_MIE * pm * uMieStrength);

    // combined scattering modulated by altitude
    vec3 scattering = (rayleigh + mie) * localD;

    // color mixing (day/twilight) for main scattering
    float dayMix = smoothstep(-0.3, 0.6, sunDotN);
    vec3 atmoColor = mix(uTwilightColor, uAtmosphereDayColor, dayMix);

    // final main scattering color
    vec3 finalColor = scattering * atmoColor * uAtmosphereIntensity;

    // --- RIM (EDGE) GLOW: smoother gradient + separate halo ---
    // rimAngle: 0 at face-on, 1 at grazing/perpendicular (limb)
    float viewDot = dot(viewDir, N); // camera->frag . normal
    float rimAngle = clamp(1.0 - abs(viewDot), 0.0, 1.0);

    // Use smoothstep to create a soft rim between start and end (user tunable)
    float rimGrad = smoothstep(uRimStart, uRimEnd, rimAngle);

    // optionally sharpen or soften by power (preserves smoothness)
    rimGrad = pow(rimGrad, max(0.0001, uRimPower * 0.05)); // scale power so gui values aren't too extreme

    // altitude-based boost: make rim more visible when near surface (or control how altitude affects rim)
    float altBoost = mix(1.0, 1.0 + uRimAltitudeBoost, 1.0 - hNorm);
    float rimFactor = rimGrad * altBoost;

    // rim color mixes separately for day/twilight using same dayMix
    vec3 rimColor = mix(uRimTwilightColor, uRimDayColor, dayMix);

    // Add rim contribution (separate intensity)
    finalColor += rimColor * rimFactor * uRimIntensity * uAtmosphereIntensity;

    // --- Secondary outer halo: a broad soft band outside the rim, independent tint ---
    // haloFactor uses thickness & softness: starts at uHaloThickness, fades over uHaloSoftness
    float haloFactor = smoothstep(uHaloThickness, uHaloThickness + max(0.0001, uHaloSoftness), rimAngle);
    // make halo distinct but softer: reduce influence with altitude a bit (less when higher)
    float haloAltitudeFade = mix(1.0, 0.4, hNorm);
    finalColor += uHaloColor * haloFactor * uHaloIntensity * haloAltitudeFade * uAtmosphereIntensity;

    // legacy small glow (optional additional edge from scattering)
    float extraEdge = pow(1.0 - abs(viewDot), uScatteringPower);
    finalColor += extraEdge * uTwilightColor * 0.12 * uAtmosphereIntensity;

    // debug modes: visualize components if needed
    if (uDebugMode == 1) {
        // Rayleigh only visualization (amplified)
        vec3 visR = BASE_RAYLEIGH * pr * uRayleighStrength * localD * 40.0;
        gl_FragColor = vec4(1.0 - exp(-visR), 1.0);
        return;
    } else if (uDebugMode == 2) {
        // Mie only visualization (amplified)
        vec3 visM = vec3(BASE_MIE * pm * uMieStrength * localD * 40.0);
        gl_FragColor = vec4(1.0 - exp(-visM), 1.0);
        return;
    }

    // tonemap so small values become visible
    finalColor = vec3(1.0) - exp(-finalColor);

    // ALPHA — smoother fade controlled by density & rim/halo
    // make alpha weaker for low density (space side) and stronger around rim/halo
    float alphaBase = localD * uAtmosphereIntensity * 0.9;
    float rimAlpha = rimFactor * 0.9;
    float haloAlpha = haloFactor * 0.6;
    float alpha = clamp(alphaBase + rimAlpha * 0.8 + haloAlpha * 0.6, 0.0, 1.0);

    gl_FragColor = vec4(finalColor, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
