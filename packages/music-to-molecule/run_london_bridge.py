import os
import sys
import json
import re
from pathlib import Path

# 确保当前目录在路径中
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from inference import run_inference
import view

def safe_name(x):
    return re.sub(r"[^a-zA-Z0-9_\-.]", "_", str(x))

if __name__ == "__main__":
    # 1. 创建输入 jsonl 文件
    input_jsonl = "single_happy_birthday.jsonl"
    midi_path = "../03_生日快乐_Happy_Birthday.mid"
    
    with open(input_jsonl, "w", encoding="utf-8") as f:
        json.dump({"id": "Happy_Birthday", "midi_path": midi_path}, f, ensure_ascii=False)
        f.write("\n")
    
    print(f"Created input file: {input_jsonl}")
    
    # 2. 运行推理
    output_dir = "output_happy_birthday_v2"
    records, summary = run_inference(
        config_path="./config.json",
        ckpt_path="./model_last(2).pt",
        input_list=input_jsonl,
        output_dir=output_dir,
        batch_size=1,
        seed=42,
        beam_size=32,
        num_return_sequences=20,
        repeat_token_penalty=0,
        no_repeat_ngram_size=3,
        repeat_ngram_penalty=1.5,
        top_qed_k=3,
    )
    
    print("\n===== Summary =====")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    
    # 3. 打印最佳结果
    rec = records[0]
    best = rec["best"]
    print(f"\n===== Best Result for {rec['id']} =====")
    print(f"SMILES: {best['pred_smiles']}")
    print(f"Canonical SMILES: {best['canonical_smiles']}")
    print(f"QED: {best['qed']}")
    
    # 4. 生成可视化图片
    fig_dir = Path(output_dir) / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)
    
    fig_path = fig_dir / f"{safe_name(rec['id'])}.png"
    
    view.visualize_music_to_molecule(
        midi_path=rec["midi_path"],
        smiles=best["pred_smiles"],
        sample_id=rec["id"],
        score=best["qed"],
        save_path=str(fig_path),
        fs=8,
        max_time=30,
    )
    
    print(f"\nFigure saved to: {fig_path}")
    
    # 5. 单独保存分子二维图片
    from rdkit import Chem
    from rdkit.Chem import Draw
    
    mol = Chem.MolFromSmiles(best["pred_smiles"])
    if mol is not None:
        mol_img_path = fig_dir / f"{safe_name(rec['id'])}_molecule_only.png"
        Draw.MolToFile(mol, filename=str(mol_img_path), size=(600, 600))
        print(f"Molecule-only image saved to: {mol_img_path}")
