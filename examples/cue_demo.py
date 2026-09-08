"""Open this file and click Open Manim Cue above CueDemo."""
from pathlib import Path

from manim import (
    BLUE, LEFT, RIGHT, TEAL, UP, YELLOW, Create, Dot, FadeIn,
    Scene, Square, Text,
)


class CueDemo(Scene):
    def construct(self):
        self.next_section("Opening")
        title = Text("Manim Cue", font_size=42).to_edge(UP)
        square = Square(color=TEAL).shift(LEFT * 2)
        dot = Dot(color=YELLOW).shift(RIGHT * 2)
        self.add(title)
        self.play(Create(square), FadeIn(dot), run_time=0.8, subcaption="Two animations, one reached play")

        self.next_section("Repeated calls")
        for color in (BLUE, TEAL):
            self.play(square.animate.set_color(color).shift(RIGHT * 0.5), run_time=0.35)
        self.add_sound(str(Path(__file__).with_name("cue.wav")), time_offset=-0.25, gain=-8)
        self.add_subcaption("Cue placement is earlier than its declaration", duration=0.6, offset=-0.25)

        self.next_section("Waits")
        self.wait(0.35, frozen_frame=False)
        self.wait(0.35, frozen_frame=True)
        start = self.time
        dot.add_updater(lambda mob, dt: mob.shift(LEFT * dt))
        self.wait(2, stop_condition=lambda: self.time >= start + 0.6)
        dot.clear_updaters()
        self.next_section("Complete")


class StillExample(Scene):
    def construct(self):
        self.add(Square(color=TEAL))
