from random import random
from typing import *

import gstools as gs
import pyvista as pv
from pyvista import PolyData, MultiBlock, UnstructuredGrid
from pyvista.plotting import AffineWidget3D
from pyvista.plotting.actor import Actor

from ..views.app_frame import AppFrame
from ..views.navigator import SceneNavigatorDelegate


class AppController(SceneNavigatorDelegate):
    def __init__(self, frame: AppFrame):
        self._scene = frame.scene_view
        self._navigator = frame.navigator
        self._plotter = frame.scene_view.plotter

        self._actors: List[Actor] = []
        self._plotter.add_camera_orientation_widget()

        self._navigator.delegate = self
        self._widget: AffineWidget3D | None = None

    def close(self):
        if self._plotter:
            self._plotter.close()
            self._plotter = None

    def reset_camera(self) -> None:
        self._plotter.reset_camera()

    def clear(self) -> None:
        if not self._plotter:
            return

        if self._widget:
            self._widget.remove()
            self._widget = None

        for actor in self._actors:
            self._plotter.remove_actor(actor)

        #
        self._actors = []
        self._navigator.clear()

    def import_stl(self, filename: str) -> None:
        # STL 로딩
        mesh: PolyData = cast(pv.PolyData, pv.get_reader(filename).read())
        mesh.compute_normals()

        # 개별 연결된 parts 로 분리하여 등록
        bodies: MultiBlock = mesh.split_bodies()
        largest = None
        max_vol = 0

        for idx, body in enumerate(bodies):  # type: int, UnstructuredGrid
            c = random(), random(), random()
            actor: Actor = self._plotter.add_mesh(body, color=c)
            dx = actor.bounds[1] - actor.bounds[0]
            dy = actor.bounds[3] - actor.bounds[2]
            dz = actor.bounds[5] - actor.bounds[4]
            vol = dx * dy * dz
            if vol > max_vol:
                largest = actor
                max_vol = vol

            if not actor.GetObjectName():
                actor.SetObjectName(f"건물 {idx + 1}")

            self._actors.append(actor)

        largest.SetObjectName(f"지면")

        #
        self._navigator.load_actors(self._actors)
        self.reset_camera()

    def generate_streamlines(self) -> None:
        dims, spacing, origin = (40, 30, 10), (1, 1, 1), (0, 0, 0)
        mesh = pv.UniformGrid(dims=dims, spacing=spacing, origin=origin)
        model = gs.Gaussian(dim=3, var=3, len_scale=1.5)
        srf = gs.SRF(model, mean=(0.5, 0, 0), generator="VectorField", seed=198412031)
        srf.mesh(mesh, points="points", name="Velocity")

        streamlines = mesh.streamlines(
            "Velocity",
            terminal_speed=0.0,
            n_points=800,
            source_radius=2.5,
        )
        streamlines = streamlines.scale(10)

        # adding an outline might help navigating in 3D space
        # p.add_mesh(mesh.outline(), color="k")
        actor = self._plotter.add_mesh(
            streamlines.tube(radius=0.5),
            show_scalar_bar=False,
            diffuse=0.5,
            ambient=0.5,
        )
        actor.SetObjectName("바람")

        self._actors.append(actor)
        self._navigator.load_actors(self._actors)

    def on_actor_selected(self, index: int, actor: Actor) -> None:
        if self._widget:
            self._widget.remove()

        self._widget = self._plotter.add_affine_transform_widget(actor)
        self._plotter.set_focus(actor.center)

        # self._plotter.add_point_labels([actor.center], [f"#{index + 1}"])


__all__ = [
    'AppController'
]
