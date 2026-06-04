Vision model assets
===================

Real CPR vision uses MediaPipe Pose Landmarker and expects this asset:

- `pose_landmarker_lite.task`

Place the model file directly in `android/app/src/main/assets/`. The app does
not download this binary at runtime; if the asset is missing, the camera remains
a recording/preview source and no live CPR recognition metrics are emitted.
