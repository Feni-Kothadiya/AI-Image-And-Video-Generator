const collapse = (value) => String(value || "").trim().replace(/\s+/g, " ");

export function compileGenerationPrompt(value) {
  const brief = collapse(value);
  return [
    "PRIMARY CREATIVE BRIEF (follow this exactly): " + brief,
    "Create one coherent, finished image. Keep the requested subject, action, setting, era, mood, medium, and visual style as the controlling intent; do not replace them with a generic alternative.",
    "COMPOSITION: establish one unmistakable focal subject, intentional framing, readable foreground/midground/background separation, natural scale relationships, and clean edges without accidental crops or tangencies.",
    "LIGHT AND MATERIALS: use a physically consistent light direction, believable contact shadows and reflections, controlled highlights, and material-specific texture rather than plastic or waxy surfaces.",
    "PEOPLE AND ANIMALS: preserve authentic individual features, natural skin or fur texture, plausible anatomy, correct hands, eyes and limbs, and realistic interaction with clothing, objects and the environment.",
    "OUTPUT DISCIPLINE: preserve the aspect ratio requested by the application. Produce a single frame, not a collage or comparison. Do not add captions, logos, signatures, borders or watermarks unless the brief explicitly requests them. Avoid duplicate subjects, malformed anatomy, floating objects, smeared detail and meaningless text.",
  ].join("\n");
}

export function compileEditPrompt(value, { background = "Original" } = {}) {
  const mutation = collapse(value);
  return [
    "SOURCE CHECKPOINT: use the supplied image as the authoritative source.",
    "REQUESTED MUTATION: " + mutation,
    "EDIT SCOPE: perform only the requested change in the smallest visually necessary area. Do not add, remove, move, restyle or rewrite unrelated content.",
    "IDENTITY LOCK: preserve every person's recognizable facial identity, age, expression, skin tone, hair, body proportions and pose unless the requested mutation explicitly names that attribute.",
    "COMPOSITION LOCK: preserve the source aspect ratio, crop, camera position, perspective, subject placement, lighting direction and overall color grade. Keep text and logos unchanged unless they are the explicit edit target.",
    background === "Original"
      ? "BACKGROUND LOCK: keep the original background and its geometry materially unchanged."
      : "BACKGROUND CHANGE: adapt only the background to the requested scene while keeping foreground identity, pose, silhouette and edge detail stable.",
    "INTEGRATION: allow only the minimal boundary blending, contact shadow, reflection and color spill needed for a believable edit. If the requested target is absent or ambiguous, favor preserving the source instead of inventing a replacement.",
    "ACCEPTANCE CHECK: the requested change is clear, source identity remains recognizable, protected content is materially stable, anatomy is plausible, and no watermark, caption or unrelated object has been introduced.",
  ].join("\n");
}
