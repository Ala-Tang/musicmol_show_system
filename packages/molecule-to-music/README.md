# smile_to_midi

A lightweight SMILES-to-MIDI converter based on `music21`.

This package converts molecular SMILES strings into MIDI files for creative molecular sonification.

---

## 🔒 Note

This package is distributed as a **compiled module**.  
The internal implementation is not exposed; only the public API is available.

---

## 📦 Installation

### Requirements

- Python >= 3.10
- music21

Install dependency:

```bash
pip install music21,rdkit
```


### Usage
```python
from smile_to_midi_v10 import smiles_to_midi, smiles_to_score

output_path = smiles_to_midi(
    smiles="CC(=O)OC1=CC=CC=C1C(=O)O",
    output_path="aspirin.mid",
    title="Aspirin",
    tempo_bpm=120,
    note_duration=1.0,
    overlap=0.8,
    rest_duration=0.1,
)

print(output_path)
```