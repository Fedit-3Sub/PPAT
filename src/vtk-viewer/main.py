from typing import *

import vtkmodules.vtkRenderingOpenGL2  # noqa
from trame.app import get_server
from trame.widgets import vtk, vuetify
from trame_vuetify.ui.vuetify import SinglePageWithDrawerLayout
from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkStructuredGrid
from vtkmodules.vtkFiltersCore import vtkTubeFilter
from vtkmodules.vtkFiltersFlowPaths import vtkStreamTracer
from vtkmodules.vtkFiltersModeling import vtkOutlineFilter
from vtkmodules.vtkFiltersSources import vtkLineSource
from vtkmodules.vtkIOLegacy import vtkStructuredPointsReader
from vtkmodules.vtkInteractionStyle import vtkInteractorStyleTrackballCamera
from vtkmodules.vtkInteractionWidgets import vtkOrientationMarkerWidget
from vtkmodules.vtkRenderingAnnotation import vtkCubeAxesActor, vtkAxesActor, vtkScalarBarActor
from vtkmodules.vtkRenderingCore import (
    vtkRenderer,
    vtkRenderWindow,
    vtkRenderWindowInteractor,
    vtkActor,
    vtkPolyDataMapper, vtkColorTransferFunction
)

# 필요한 데이터 파일 경로
DATA_PATH = "data/wind.vtk"
STL_PATH = "data/세종_스마트시티_모델_20221019.stl"

# 시작점 및 끝점 초기 위치
bounds: Tuple[float, float, float, float, float, float] = (0, 0, 0, 0, 0, 0)
streamlines: vtkStreamTracer | None = None
line_source: vtkLineSource | None = None
renderer: vtkRenderer | None = None
render_window_interactor: vtkRenderWindowInteractor | None = None


def update_line_source_points(kx: float, ky: float):
    x_min = bounds[0]
    x_max = bounds[1]
    cur_x = x_min + kx * (x_max - x_min)

    y_min = bounds[2]
    y_max = bounds[3]
    cur_y = y_min + ky * (y_max - y_min)

    start_point = cur_x, cur_y, bounds[4]
    end_point = cur_x, cur_y, bounds[5]

    line_source.SetPoint1(*start_point)
    line_source.SetPoint2(*end_point)


# Axes widget 추가
def add_axes_widgets(renderer):
    axes_widget = vtkOrientationMarkerWidget()
    axes_widget.SetInteractor(render_window_interactor)

    # Axes Actor 설정
    axes_actor = vtkAxesActor()
    renderer.AddActor(axes_actor)
    axes_widget.SetOrientationMarker(axes_actor)

    # 크기 및 모서리 비율 설정
    axes_widget.SetViewport(0.0, 0.0, 0.2, 0.2)
    axes_widget.SetEnabled(1)
    axes_widget.InteractiveOn()

    return axes_widget


# VTK 파이프라인 생성
def create_pipeline():
    global bounds
    global streamlines
    global line_source
    global renderer
    global render_window_interactor

    renderer = vtkRenderer()
    renderer.SetBackground(0.1, 0.2, 0.4)

    render_window = vtkRenderWindow()
    # render_window.SetSize(1920, 1080)
    # render_window.SetSize(1920, 1080)

    render_window.AddRenderer(renderer)
    render_window_interactor = vtkRenderWindowInteractor()
    render_window_interactor.SetRenderWindow(render_window)

    # 수정된 부분: TrackballCamera 스타일 설정
    render_window_interactor.SetInteractorStyle(vtkInteractorStyleTrackballCamera())

    #
    add_axes_widgets(renderer)

    # # STL 파일 로드
    # stl_reader = vtkSTLReader()
    # stl_reader.SetFileName(STL_PATH)
    # stl_mapper = vtkPolyDataMapper()
    # stl_mapper.SetInputConnection(stl_reader.GetOutputPort())
    # stl_actor = vtkActor()
    # stl_actor.SetMapper(stl_mapper)
    # renderer.AddActor(stl_actor)

    structured_grid = load_structured_grid(DATA_PATH)
    bounds = structured_grid.GetBounds()

    line_source = vtkLineSource()
    line_source.SetResolution(1000)
    update_line_source_points(0.5, 0)

    streamlines = create_streamlines(structured_grid, line_source)

    # Calculate the bounds of the structured grid

    # Create a cube source to represent the bounding box
    cube_axes_actor = vtkCubeAxesActor()
    cube_axes_actor.SetBounds(bounds)
    cube_axes_actor.SetCamera(renderer.GetActiveCamera())
    cube_axes_actor.GetTitleTextProperty(0).SetColor(1.0, 1.0, 1.0)
    cube_axes_actor.GetLabelTextProperty(0).SetColor(1.0, 1.0, 1.0)
    renderer.AddActor(cube_axes_actor)

    #
    streamline_actor = create_streamline_actor(streamlines)
    outline_actor = create_outline_actor(structured_grid)

    # Create the line actor
    line_mapper = vtkPolyDataMapper()
    line_mapper.SetInputConnection(line_source.GetOutputPort())

    line_actor = vtkActor()
    line_actor.SetMapper(line_mapper)
    line_actor.GetProperty().SetLineWidth(2)
    line_actor.GetProperty().SetColor(1, 1, 1)

    # Add line actor to the renderer
    renderer.AddActor(line_actor)

    renderer.AddActor(streamline_actor)
    renderer.AddActor(outline_actor)
    renderer.ResetCamera()

    return render_window


# 구조적 격자 데이터 로딩 함수
def load_structured_grid(file_path):
    reader = vtkStructuredPointsReader()
    reader.SetFileName(file_path)
    reader.Update()
    structured_points = reader.GetOutput()

    points = vtkPoints()
    num_points = structured_points.GetNumberOfPoints()

    # Calculate the center of the points
    center = [0.0, 0.0, 0.0]
    for i in range(num_points):
        point = structured_points.GetPoint(i)
        center[0] += point[0]
        center[1] += point[1]
        center[2] += point[2]
    center = [c / num_points for c in center]

    # Set points to the structured grid
    grid = vtkStructuredGrid()
    grid.SetDimensions(*structured_points.GetDimensions())
    for i in range(num_points):
        point = structured_points.GetPoint(i)
        points.InsertPoint(i, point[0] - center[0], point[1] - center[1], point[2] - center[2])

    grid.SetPoints(points)
    grid.GetPointData().SetScalars(structured_points.GetPointData().GetScalars())
    grid.GetPointData().SetVectors(structured_points.GetPointData().GetVectors('wind_velocity'))

    return grid


# 스트림라인 생성 함수
def create_streamlines(grid, line_source):
    streamer = vtkStreamTracer()
    streamer.SetInputData(grid)
    streamer.SetSourceConnection(line_source.GetOutputPort())
    streamer.SetMaximumPropagation(70)
    streamer.SetInitialIntegrationStep(0.1)
    streamer.SetIntegrationDirectionToForward()
    streamer.SetComputeVorticity(False)
    return streamer


# 스트림라인 아웃라인 액터 생성 함수
def create_streamline_actor(streamer):
    # 컬러맵 객체 생성
    color_map = vtkColorTransferFunction()
    color_map.SetVectorModeToMagnitude()
    color_map.SetColorSpaceToRGB()
    color_map.AddRGBPoint(0, 0, 0, 1)
    color_map.AddRGBPoint(11, 1, 1, 1)
    color_map.AddRGBPoint(22, 1, 0, 0)
    color_map.SetRange(0, 25)

    #
    tube_filter = vtkTubeFilter()
    tube_filter.SetInputConnection(streamer.GetOutputPort())
    tube_filter.SetRadius(0.1)
    tube_filter.SetNumberOfSides(12)

    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(tube_filter.GetOutputPort())
    mapper.SetLookupTable(color_map)

    actor = vtkActor()
    actor.SetMapper(mapper)

    #
    scalar_bar_actor = vtkScalarBarActor()
    scalar_bar_actor.SetLookupTable(color_map)
    scalar_bar_actor.SetNumberOfLabels(7)
    scalar_bar_actor.UnconstrainedFontSizeOn()
    scalar_bar_actor.SetMaximumWidthInPixels(100)
    scalar_bar_actor.SetMaximumHeightInPixels(800 // 3)
    scalar_bar_actor.SetTitle("Wind Speed")
    renderer.AddActor2D(scalar_bar_actor)

    return actor


# 아웃라인 액터 생성 함수
def create_outline_actor(grid):
    outline_filter = vtkOutlineFilter()
    outline_filter.SetInputData(grid)

    mapper = vtkPolyDataMapper()
    mapper.SetInputConnection(outline_filter.GetOutputPort())

    actor = vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(1, 1, 1)

    return actor


# 트람 서버 설정
server = get_server(client_type='vue2')
controller = server.controller

state = server.state
state.trame__title = "KETI Digital Twin - Simulated Wind Viewer"


@state.change('start_x')
def on_start_x_changed(**kwargs):
    update_line_source_points(state.start_x, state.start_y)
    view.update()


@state.change('start_y')
def on_start_y_changed(**kwargs):
    update_line_source_points(state.start_x, state.start_y)
    view.update()


def ui_card(title):
    with vuetify.VCard():
        vuetify.VCardTitle(
            title,
            classes="grey darken-1 py-1 grey--text text--lighten-3",
            style="user-select: none; cursor: pointer",
            hide_details=True,
            dense=True,
        )
        content = vuetify.VCardText(classes="py-2")
    return content


with SinglePageWithDrawerLayout(server) as layout:
    layout.title.set_text("시뮬레이션 결과 렌더링")
    layout.toolbar.dense = True  # 툴바 최소화

    with layout.drawer:
        with ui_card(title="시드 설정"):
            vuetify.VSlider(
                v_model=("start_x", 0.0),
                min=0,
                max=1,
                step=0.01,
                label="X",
                classes="mt-1",
                hide_details=True,
                dense=True,
            )

            vuetify.VSlider(
                v_model=("start_y", 0.0),
                min=0,
                max=1,
                step=0.01,
                label="Y",
                classes="mt-1",
                hide_details=True,
                dense=True,
            )

    with layout.toolbar:
        # toolbar components
        vuetify.VSpacer()
        vuetify.VDivider(vertical=True, classes="mx-2")

        vuetify.VCheckbox(
            v_model=("viewMode", "local"),
            on_icon="mdi-lan-disconnect",
            off_icon="mdi-lan-connect",
            true_value="local",
            false_value="remote",
            classes="mx-1",
            hide_details=True,
            dense=True,
        )

        vuetify.VCheckbox(
            v_model=("$vuetify.theme.dark", True),
            on_icon="mdi-lightbulb-off-outline",
            off_icon="mdi-lightbulb-outline",
            classes="mx-1",
            hide_details=True,
            dense=True,
        )

    with layout.content:
        with vuetify.VContainer(fluid=True, classes="pa-0 fill-height"):
            # view = vtk.VtkRemoteView(create_pipeline())
            # view = vtk.VtkLocalView(create_pipeline())
            view = vtk.VtkRemoteLocalView(
                create_pipeline(),
                namespace="view",
                mode="local",
                interactive_ratio=1,
                disable_auto_switch=True,
            )

            controller.on_server_ready.add(view.update)

# 메인 함수 설정
if __name__ == "__main__":
    server.start()
