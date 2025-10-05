// shaders/earth/fragment.glsl
precision highp float;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vPosition;

// textures
uniform sampler2D uDayTexture;
uniform sampler2D uNightTexture;
uniform sampler2D uSpecularCloudsTexture;
uniform sampler2D uCloudsTexture;

// scattering / lighting (added)
uniform vec3 uSunDirection;
uniform vec3 uAtmosphereDayColor;
uniform vec3 uTwilightColor;
uniform float uAtmosphereIntensity;

// -------------------- PBR helpers (GGX + Schlick) --------------------
vec3 fresnelSchlick(float cosTheta, vec3 F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

float DistributionGGX(vec3 N, vec3 H, float roughness) {
    float a      = roughness * roughness;
    float a2     = a * a;
    float NdotH  = max(dot(N, H), 0.0);
    float NdotH2 = NdotH * NdotH;

    float num   = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = 3.14159265 * denom * denom;
    return num / denom;
}

float GeometrySchlickGGX(float NdotV, float roughness) {
    float r = (roughness + 1.0);
    float k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    float ggx1 = GeometrySchlickGGX(NdotV, roughness);
    float ggx2 = GeometrySchlickGGX(NdotL, roughness);
    return ggx1 * ggx2;
}

// -------------------- atmospheric tint helper (your code) --------------------
vec3 atmosphericTint(vec3 surfaceColor, vec3 viewDir, vec3 normal, vec3 lightDir) {
    // Simple atmospheric tint based on view angle
    float viewAngle = dot(viewDir, normal);
    float lightAngle = dot(lightDir, normal);
    
    // Rayleigh-like scattering approximation
    float scatter = pow(1.0 - abs(viewAngle), 2.0);
    float sunScatter = max(0.0, lightAngle) * 0.5;
    
    vec3 tint = mix(uTwilightColor, uAtmosphereDayColor, sunScatter);
    return mix(surfaceColor, surfaceColor * tint, scatter * 0.3 * uAtmosphereIntensity);
}

// -------------------- main --------------------
void main()
{
    vec3 viewDirection = normalize(vPosition - cameraPosition); // camera -> surface
    vec3 normal = normalize(vNormal);
    vec3 color = vec3(0.0);

    // Sun orientation
    vec3 L = normalize(uSunDirection);
    float sunOrientation = dot(L, normal);

    // Day / night base
    float dayMix = smoothstep(-0.25, 0.5, sunOrientation);
    vec3 dayColor = texture2D(uDayTexture, vUv).rgb;
    vec3 nightColor = texture2D(uNightTexture, vUv).rgb;
    color = mix(nightColor, dayColor, dayMix);

    // Soft cloud shadows
    float blur = 0.002;
    float c = 0.0;
    c += texture2D(uCloudsTexture, vUv + vec2( blur, 0.0)).r;
    c += texture2D(uCloudsTexture, vUv + vec2(-blur, 0.0)).r;
    c += texture2D(uCloudsTexture, vUv + vec2(0.0,  blur)).r;
    c += texture2D(uCloudsTexture, vUv + vec2(0.0, -blur)).r;
    c += texture2D(uCloudsTexture, vUv).r;
    c /= 5.0;

    float shadowStrength = 0.6;
    float sunLight = max(sunOrientation, 0.0);
    float shadowFactor = mix(1.0, 1.0 - shadowStrength, c);
    color *= mix(1.0, shadowFactor, sunLight);

    // baked / lower clouds overlay
    vec2 specularCloudColor = texture2D(uSpecularCloudsTexture, vUv).rg;
    float cloudMix = smoothstep(0.2, 1.0, specularCloudColor.g);
    cloudMix *= dayMix;
    color = mix(color, vec3(1.0), cloudMix);

    // subtle atmosphere tint (small contribution)
    float atmosphereDayMix = smoothstep(-0.5, 1.0, sunOrientation);
    vec3 atmosphereColor = mix(uTwilightColor, uAtmosphereDayColor, atmosphereDayMix);
    color = mix(color, atmosphereColor, 0.03 * atmosphereDayMix);

    // ----- PBR specular (GGX) -----
    vec3 V = normalize(cameraPosition - vPosition); // camera -> surface
    vec3 H = normalize(V + L);

    float NdotL = max(dot(normal, L), 0.0);
    float NdotV = max(dot(normal, V), 0.0);
    float NdotH = max(dot(normal, H), 0.0);
    float VdotH = max(dot(V, H), 0.0);

    float specMap = specularCloudColor.r;
    specMap = clamp(specMap * 1.5, 0.02, 1.0);

    vec3 F0_water = vec3(0.02);
    vec3 F0_land  = vec3(0.04);
    vec3 F0 = mix(F0_water, F0_land, specMap);

    float roughness = mix(0.06, 0.45, specMap);
    roughness = clamp(roughness, 0.02, 0.6);

    float D = DistributionGGX(normal, H, roughness);
    float G = GeometrySmith(normal, V, L, roughness);
    vec3  F = fresnelSchlick(VdotH, F0);

    float denom = max(4.0 * NdotV * NdotL, 0.0001);
    vec3 specular = (D * G * F) / denom;

    float finalBoost = 1.6;
    color += specular * NdotL * dayMix * finalBoost;

    // Apply atmospheric tint to final surface color
    color = atmosphericTint(color, V, normal, L);

    // Final output
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
