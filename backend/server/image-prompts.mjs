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
    "IDENTITY LOCK — HIGHEST PRIORITY: every visible person must remain unmistakably the same individual. Preserve facial geometry, eye shape and spacing, eyebrows, nose, lips, jawline, ears, skin tone, age, ethnicity, hairline, hairstyle and distinctive marks. Do not generate a new face, face-swap, beautify, de-age, age, slim, masculinize, feminize, merge identities or make different people look alike.",
    "SUBJECT LOCK: preserve the number of people, each person's body proportions and the relationship between subjects. Keep the original expression, gaze and pose unless the creative brief explicitly requests a change to that exact attribute. Hands, limbs, clothing and physical contact must remain anatomically coherent.",
    "REQUESTED TRANSFORMATION: " + mutation,
    "EDIT SCOPE: change only the environment, wardrobe, lighting or named target required by the transformation. Treat the face and all unrequested content as protected. Do not add, remove, move, restyle or rewrite unrelated content.",
    "COMPOSITION LOCK: preserve the source aspect ratio and avoid accidental cropping. Preserve camera perspective and subject placement unless the requested transformation explicitly requires reframing. Keep existing text and logos unchanged unless they are the explicit target.",
    background === "Original"
      ? "BACKGROUND LOCK: keep the original background and its geometry materially unchanged."
      : "BACKGROUND CHANGE: adapt only the background to the requested scene while keeping foreground identity, pose, silhouette and edge detail stable.",
    "INTEGRATION: allow only the minimal edge blending, contact shadow, reflection and color spill needed for a believable result. Keep real skin texture and facial asymmetry. If the requested target is absent or ambiguous, preserve the source instead of inventing a replacement.",
    "ACCEPTANCE CHECK: reject the result if any face shape, facial feature, age, skin tone, hairline or person count has drifted. Accept only when the requested transformation is clear, every source identity remains recognizable, protected content is materially stable, anatomy is plausible, and no watermark, caption or unrelated object has been introduced.",
  ].join("\n");
}
