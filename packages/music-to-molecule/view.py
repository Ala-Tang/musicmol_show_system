import os
import re
import json
import math
import random
from pathlib import Path
from typing import List, Dict

from rdkit import Chem
from rdkit.Chem import Draw

import matplotlib.pyplot as plt
import pretty_midi

def draw_midi_pianoroll(midi_path, ax=None, fs=8, max_time=30):
    pm = pretty_midi.PrettyMIDI(midi_path)
    pr = pm.get_piano_roll(fs=fs)

    if max_time is not None:
        max_frames = min(pr.shape[1], int(max_time * fs))
        pr = pr[:, :max_frames]

    if ax is None:
        fig, ax = plt.subplots(figsize=(7, 4))

    ax.imshow(pr, aspect="auto", origin="lower", cmap="magma")
    ax.set_title("MIDI Piano Roll")
    ax.set_xlabel("Time")
    ax.set_ylabel("Pitch")
    return ax

def smiles_to_pil(smiles, size=(450, 450)):
    if smiles is None:
        return None
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    return Draw.MolToImage(mol, size=size)

def visualize_music_to_molecule(
    midi_path,
    smiles,
    sample_id=None,
    score=None,
    save_path=None,
    fs=8,
    max_time=30,
):
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    try:
        draw_midi_pianoroll(midi_path, ax=axes[0], fs=fs, max_time=max_time)
    except Exception as e:
        axes[0].text(0.5, 0.5, f"Failed to load MIDI\n{e}", ha="center", va="center")
        axes[0].set_axis_off()

    img = smiles_to_pil(smiles)
    if img is not None:
        axes[1].imshow(img)
        axes[1].axis("off")
        axes[1].set_title("Predicted Molecule")
    else:
        axes[1].text(0.5, 0.5, "Invalid SMILES", ha="center", va="center")
        axes[1].set_axis_off()

    title = f"id={sample_id}"
    if score is not None:
        title += f" | score={score:.4f}"
    fig.suptitle(title, fontsize=14)

    plt.tight_layout()

    if save_path is not None:
        fig.savefig(save_path, dpi=200, bbox_inches="tight")

    plt.show()