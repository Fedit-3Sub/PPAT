from qtpy.QtCore import Qt
from qtpy.QtWidgets import *

from .navigator import SceneNavigator
from .scene import SceneView


class AppFrame(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)

        rows = QHBoxLayout()
        self.setLayout(rows)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        rows.addWidget(splitter)

        self._nav = SceneNavigator(self)
        self._scene = SceneView(self)

        splitter.addWidget(self._nav)
        splitter.addWidget(self._scene)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 3)

    @property
    def scene_view(self) -> SceneView:
        return self._scene

    @property
    def navigator(self) -> SceneNavigator:
        return self._nav


__all__ = [
    'AppFrame'
]
