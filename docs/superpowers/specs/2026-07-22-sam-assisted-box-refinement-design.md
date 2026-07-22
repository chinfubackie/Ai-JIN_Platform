# SAM-Assisted Tight Bounding Box Editing Design

Date: 2026-07-22
Status: Approved interaction design
Target: `webapp/frontend/src/pages/Annotator.jsx`

## Context

The Annotator already renders four visual corner handles for a selected box, but those handles are not interactive. The existing `/api/sam/predict` endpoint accepts a pixel-space `bbox` prompt and returns normalized SAM polygons. Point-prompt SAM currently turns an accepted preview into a polygon, while this feature must preserve YOLO Detection boxes.

## Goals

- Let an annotator resize a selected bounding box until it closely fits the workpiece.
- Let an annotator move a selected bounding box without deleting and redrawing it.
- Use the selected box as a SAM box prompt to propose a tighter detection box.
- Require explicit confirmation before replacing the existing box.
- Preserve the selected class, YOLO Detection label format, and undo/redo behavior.

## Non-Goals

- Do not convert the selected detection box into a segmentation polygon.
- Do not save both a box and polygon for the same SAM refinement.
- Do not call SAM automatically after every manual drag.
- Do not change the existing point-prompt polygon workflow.
- Do not change the label API or on-disk YOLO format.

## Interaction Design

### Manual Box Editing

When the Select tool is active and a box is selected, render eight handles:

- Four corner handles resize two axes.
- Four edge-center handles resize one axis.
- Dragging inside the selected box moves the entire box.

Handles use a larger invisible hit target than their visible square so they remain practical at different zoom levels. The cursor indicates the active operation: horizontal, vertical, diagonal resize, or move.

On mouse down, capture the complete pre-drag annotation snapshot, the selected box, and the active drag operation. Use pointer capture so a drag continues when the pointer temporarily leaves the canvas. On pointer move, update the box live. Keep all edges inside the image and enforce a minimum size of four natural-image pixels on each axis. An edge cannot cross its opposite edge.

On pointer up, add the captured pre-drag snapshot as exactly one undo history entry if the box changed. Keep the box selected. Cancelling before a real change must not add history.

### SAM Tighten Action

Add a `Tighten with SAM` action in the SAM controls. It is enabled only when:

- An image is loaded.
- A valid box is selected.
- A SAM model supported by `/api/sam/predict` is selected.
- No SAM request is already running.

The action converts the selected normalized box to natural-image pixel coordinates and submits it as the existing endpoint's `bbox` form field. The selected SAM model is submitted in the existing `model` field.

SAM3 concept/exemplar mode remains separate. If SAM3 is selected, the tighten action is disabled and explains that a SAM/SAM2 model is required.

## Refinement Calculation

The endpoint returns one or more normalized polygons. The client filters out invalid polygons, calculates each polygon's bounding rectangle, and chooses the candidate with the greatest intersection-over-union against the selected prompt box. If overlap is tied, choose the polygon with the largest area.

Calculate the proposed detection box from the selected polygon:

1. Find minimum and maximum normalized X and Y coordinates.
2. Clamp the bounds to `[0, 1]`.
3. Reject an empty or sub-minimum result.
4. Convert the bounds to the existing `[class_id, cx, cy, width, height]` representation.
5. Preserve the selected box's `class_id`.

This produces the tight axis-aligned bounding rectangle around the SAM contour while keeping the annotation compatible with YOLO Detection.

## Preview and Commit

Store the proposal separately from saved box state. Draw it as a dashed purple box while leaving the current box visible so the annotator can compare them.

Show two commands:

- `Use`: push one undo snapshot, replace only the selected box, keep it selected, clear the preview, and show a success toast.
- `Discard`: clear the preview without changing annotations or history.

Starting another edit, changing images, deleting the selected box, or loading new labels clears a stale refinement preview. Saving before confirmation saves only the current box, never the preview.

## State and Data Flow

Manual drag state stays in refs because pointer movement is transient. The rendered box state remains in the existing `boxes` array.

SAM box preview state is distinct from the existing polygon preview state. This prevents the current `applySamPreview()` polygon behavior from accidentally creating a duplicate label.

No backend contract change is required. The frontend uses the existing request fields and response payload:

```text
POST /api/sam/predict
image=<jpeg blob>
bbox=[x1, y1, x2, y2]
model=<selected SAM model>

response.polygons=[...]
```

## Error Handling

- No selected box: keep the action disabled.
- Missing or invalid SAM polygon: keep the original box and show `SAM did not find a valid object`.
- Network or model failure: keep the original box and display the API error.
- Result outside the image or below minimum size: reject it without modifying history.
- Selection changes while a request is running: discard the response if it no longer belongs to the same image and box.

## Verification

### Geometry Checks

- Every corner and edge handle changes only the expected edges.
- Moving a box preserves width and height.
- Resize and move remain clamped to the image.
- A box cannot become smaller than four natural-image pixels.
- One completed drag creates one undo step; redo restores it.

### SAM Checks

- The request sends the selected box in natural-image pixel coordinates.
- The proposed box encloses the chosen SAM contour.
- `Use` replaces the selected box and preserves its class.
- `Discard`, API errors, and invalid masks leave labels unchanged.
- Saving after `Use` writes one detection box and no polygon duplicate.

### Browser Acceptance

- Verify the Annotator at desktop resolution using a real dataset image.
- Resize from all handle types and move a selected box.
- Run SAM refinement and compare the original and preview boxes.
- Confirm and discard separate previews.
- Save, reload the image, and confirm the tightened box persists.
- Verify the browser console has no new errors during the full flow.

## Considered Alternatives

### Manual Resize Only

This improves basic editing but does not use the available segmentation model to find a tighter object boundary.

### Automatic SAM After Every Drag

This adds latency to routine edits and can unexpectedly replace deliberate manual geometry. An explicit action gives the annotator control over model cost and acceptance.

### Replace the Box with a Polygon

This would change the training task from detection to segmentation and could create duplicate annotations. It does not meet the approved requirement to retain a YOLO Detection box.
