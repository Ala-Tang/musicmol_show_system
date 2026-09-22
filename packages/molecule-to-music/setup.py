from setuptools import Extension, setup
from Cython.Build import cythonize

extensions = [
    Extension(
        "smile_to_midi_v10._core",
        ["smile_to_midi_v10/_core.pyx"],
    )
]

setup(
    name="smile_to_midi",
    version="0.10.0",
    packages=["smile_to_midi"],
    ext_modules=cythonize(
        extensions,
        compiler_directives={"language_level": "3"},
    ),
    zip_safe=False,
)