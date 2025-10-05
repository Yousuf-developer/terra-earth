uniform sampler2D uCloudsTexture;
uniform sampler2D uCloudsNormal;
uniform vec3 uSunDirection;

varying vec2 vUv;
varying vec3 vNormal;

void main() {
    vec3 normal = normalize(vNormal);

    // Base cloud mask (grayscale)
    float cloudMask = texture2D(uCloudsTexture, vUv).r;

    // Sun lighting factor
    float sunLight = dot(normal, uSunDirection);

    // --- DAY SIDE ---
    vec3 dayClouds = vec3(1.0); // bright white

    // --- NIGHT SIDE ---
    // Use a dimmed/contrasty color instead of full black fade
    vec3 nightClouds = vec3(0.25); // grey "moonlit" clouds (adjust value)

    // Blend between day/night clouds using sunLight
    float dayMix = smoothstep(-0.2, 0.3, sunLight); 
    vec3 cloudColor = mix(nightClouds, dayClouds, dayMix);

    // Final alpha (semi-transparent mask)
    float alpha = cloudMask * 0.6;

    gl_FragColor = vec4(cloudColor, alpha);
}
