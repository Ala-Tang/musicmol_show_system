from rdkit import Chem
import re
from music21 import stream, note, chord, metadata, instrument, articulations, meter, tempo

def generate_full_orchestra_score(smiles):
    
    # --- 1. 深度解析器 (已修改以支持手性提取) ---
    def parse_smiles_structure(s):
        def replace_bracket(match):
            content = match.group(0) 
            # 提取原子符号
            symbol_match = re.search(r'[A-Za-z]+', content)
            symbol = symbol_match.group(0) if symbol_match else ""
            
            # --- 新增：保留手性标记作为后缀，方便后续识别 ---
            if "@@" in content:
                return symbol + "_CHIRAL_R"
            elif "@" in content:
                return symbol + "_CHIRAL_L"
            return symbol

        s_clean = re.sub(r'\[.*?\]', replace_bracket, s)
        
        structure = []
        i = 0
        n = len(s_clean)
        active_rings = set()
        
        while i < n:
            char = s_clean[i]
            
            # 1. 检测环标记
            if char.isdigit():
                ring_id = char
                if len(structure) > 0:
                    structure[-1]['in_ring'] = True
                if ring_id in active_rings:
                    active_rings.remove(ring_id)
                else:
                    active_rings.add(ring_id)
                i += 1
                continue
            
            # 这里的判断保留了原有的逻辑，但允许带有后缀的字符通过
            if char in ['=', '#', '-', '/', '\\']: 
                i += 1
                continue
            
            # 2. 识别原子 (支持识别我们添加的后缀)
            # 使用正则匹配原子符号及其可能携带的后缀
            atom_match = re.match(r'(Cl_CHIRAL_[RL]|Br_CHIRAL_[RL]|[A-Z][a-z]_CHIRAL_[RL]|[A-Z]_CHIRAL_[RL]|Cl|Br|[A-Z][a-z]|[A-Z])', s_clean[i:])
            if atom_match:
                symbol_raw = atom_match.group(0)
                i += len(symbol_raw)
            else:
                # 兜底逻辑：处理小写芳香原子或单个字符
                symbol_raw = char
                i += 1
            
            # 3. 检测分支 (保持原有逻辑)
            branches = []
            while i < n and s_clean[i] == '(':
                balance = 1
                start = i + 1
                end = start
                while balance > 0 and end < n:
                    if s_clean[end] == '(': balance += 1
                    elif s_clean[end] == ')': balance -= 1
                    end += 1
                branch_content = s_clean[start : end-1]
                branches.append(branch_content)
                i = end
                continue

            # --- 解析手性标记 ---
            chiral_type = 0 # 0: 无, 1: @, 2: @@
            final_symbol = symbol_raw
            if "_CHIRAL_L" in symbol_raw:
                final_symbol = symbol_raw.replace("_CHIRAL_L", "")
                chiral_type = 1
            elif "_CHIRAL_R" in symbol_raw:
                final_symbol = symbol_raw.replace("_CHIRAL_R", "")
                chiral_type = 2

            if final_symbol.isalpha() or (len(final_symbol) > 1 and final_symbol[0].isalpha()):
                is_aromatic = final_symbol.islower()
                is_in_ring = (len(active_rings) > 0)
                
                structure.append({
                    'symbol': final_symbol.upper(),
                    'is_aromatic': is_aromatic,
                    'in_ring': is_in_ring,
                    'is_double': False,
                    'is_triple': False,
                    'is_chiral': chiral_type, # 0, 1, 或 2
                    'branches': branches
                })
            
        # --- 双键检测 (保持原逻辑，但清理后缀干扰) ---
        backbone_str = ""
        skip = 0
        s_super_clean = s_clean.replace("_CHIRAL_L", "").replace("_CHIRAL_R", "")
        for c in s_super_clean:
            if c == '(': skip += 1
            elif c == ')': skip -= 1
            elif skip == 0: backbone_str += c
        
        tokens = re.findall(r'Cl|Br|[A-Za-z]|=|#', backbone_str)
        atom_idx = 0
        for t_i, token in enumerate(tokens):
            if token in ['=', '#']: continue
            if atom_idx < len(structure):
                is_dbl = False
                if t_i > 0 and tokens[t_i-1] == '=': is_dbl = True
                if t_i < len(tokens)-1 and tokens[t_i+1] == '=': is_dbl = True
                structure[atom_idx]['is_double'] = is_dbl

                is_tpl = False
                if t_i > 0 and tokens[t_i-1] == '#': is_tpl = True
                if t_i < len(tokens)-1 and tokens[t_i+1] == '#': is_tpl = True
                structure[atom_idx]['is_triple'] = is_tpl

                atom_idx += 1
                
        return structure

    # --- 2. 准备工作 ---
    data = parse_smiles_structure(smiles)
    score = stream.Score()
    
    v1 = stream.Part(id='Violin_1_Backbone') 
    v1.insert(0, instrument.Piano())
    v1.insert(0, meter.TimeSignature('4/4'))
    v1.insert(0, tempo.MetronomeMark(number=100))
    
    branch_parts = [] 
    part_end_times = [] 

    # --- 音高映射表 (保持你的电负性规则) ---
    pitch_map_backbone = {
        'C': 'C5', 'N': 'F5', 'O': 'A5', 'F': 'B5', 
        'Cl': 'G5', 'Br': 'E5', 'I': 'E5', 'At': 'E5',
        'S': 'D5', 'Se': 'D5', 'Te': 'D5',
        'P': 'C5', 'As': 'C5', 'B': 'C5', 'Si': 'C5', 'other': 'E6'
    }
    pitch_map_branch = {k: v.replace('5', '4') for k, v in pitch_map_backbone.items()}

    VOL_BACKBONE = 110  
    VOL_BRANCH = 77     

    # --- 辅助函数：生成音符 (已修改支持手性和声) ---
    def create_notes(item, pitch_name, velocity_val):
        notes_list = []
        
        # 定义内部逻辑：如果是手性碳，则生成和弦，否则生成单音
        def get_element(p_name, length):
            if item['symbol'] == 'C' and item.get('is_chiral', 0) > 0:
                # 为手性碳添加和声：@ 使用大三度 (E)，@@ 使用纯五度 (G)
                harmony_pitch = 'E' + p_name[-1] if item['is_chiral'] == 1 else 'G' + p_name[-1]
                c = chord.Chord([p_name, harmony_pitch], quarterLength=length)
                return c
            return note.Note(p_name, quarterLength=length)



        # 优先级 0: 三键 (#) -> 三连音 (1/3 * 3)
        # 使用 item.get() 防止部分原子数据中缺少该 key 导致报错
        if item.get('is_triple'):
            n1, n2, n3 = get_element(pitch_name, 1/3), get_element(pitch_name, 1/3), get_element(pitch_name, 1/3)
            n1.volume.velocity = n2.volume.velocity = velocity_val = n3.volume.velocity
            notes_list.extend([{'note': n1, 'rel': 0.0}, {'note': n2, 'rel': 1/3}, {'note': n3, 'rel': 2/3}])
                
        # 优先级 1: 双键 (=) -> 切分
        elif item['is_double']:
            n1, n2 = get_element(pitch_name, 0.5), get_element(pitch_name, 0.5)
            n1.volume.velocity = n2.volume.velocity = velocity_val
            notes_list.extend([{'note': n1, 'rel': 0.0}, {'note': n2, 'rel': 0.5}])
            
        # 优先级 2: 芳香环 (小写) -> 附点
        elif item['is_aromatic']:
            n1, n2 = get_element(pitch_name, 0.75), get_element(pitch_name, 0.25)
            n1.volume.velocity = n2.volume.velocity = velocity_val 
            notes_list.extend([{'note': n1, 'rel': 0.0}, {'note': n2, 'rel': 0.75}])
            
        # 优先级 3: 普通环 (在环内) -> 断奏 + 休止
        elif item['in_ring']:
            n1 = get_element(pitch_name, 0.5)
            n1.articulations.append(articulations.Staccato()) 
            n1.volume.velocity = velocity_val
            r1 = note.Rest(quarterLength=0.5)
            notes_list.extend([{'note': n1, 'rel': 0.0}, {'note': r1, 'rel': 0.5}])
            
        # 优先级 4: 普通单键 -> 全音符
        else:
            n1 = get_element(pitch_name, 1.0)
            n1.volume.velocity = velocity_val
            notes_list.append({'note': n1, 'rel': 0.0})
            
        return notes_list

    # --- 剩余主逻辑保持不变 ---
    current_offset = 0.0
    for idx, item in enumerate(data):
        sym = item['symbol']
        p = pitch_map_backbone.get(sym, 'C5')
        v1_notes = create_notes(item, p, VOL_BACKBONE)
        for n_obj in v1_notes:
            v1.insert(current_offset + n_obj['rel'], n_obj['note'])
            
        if item['branches']:
            branch_trigger_time = current_offset
            for b_str in item['branches']:
                branch_data = parse_smiles_structure(b_str)
                notes_cache = []
                marker = note.Note('C4', quarterLength=1.0)
                marker.volume.velocity = VOL_BRANCH 
                notes_cache.append({'note': marker, 'rel_time': 0.0})
                
                rel_t = 1.0 
                for b_item in branch_data:
                    b_sym = b_item['symbol']
                    b_p = pitch_map_branch.get(b_sym, 'C4')
                    b_generated = create_notes(b_item, b_p, VOL_BRANCH)
                    for gn in b_generated:
                        notes_cache.append({'note': gn['note'], 'rel_time': rel_t + gn['rel']})
                    rel_t += 1.0 
                
                phrase_end_time = branch_trigger_time + rel_t
                chosen_idx = -1
                for p_i, end_t in enumerate(part_end_times):
                    if end_t <= branch_trigger_time + 0.01:
                        chosen_idx = p_i
                        break
                if chosen_idx == -1:
                    new_id = f'Violin_{len(branch_parts) + 2}_Branch'
                    new_part = stream.Part(id=new_id)
                    new_part.insert(0, instrument.Piano())
                    branch_parts.append(new_part)
                    part_end_times.append(0.0)
                    chosen_idx = len(branch_parts) - 1
                
                target_part = branch_parts[chosen_idx]
                for note_obj in notes_cache:
                    target_part.insert(branch_trigger_time + note_obj['rel_time'], note_obj['note'])
                part_end_times[chosen_idx] = phrase_end_time

        current_offset += 1.0

    all_parts = [v1] + branch_parts
    max_duration = 0.0
    for p in all_parts:
        if p.highestTime > max_duration: max_duration = p.highestTime
    for p in all_parts:
        diff = max_duration - p.highestTime
        if diff > 0: p.insert(p.highestTime, note.Rest(quarterLength=diff))
    for p in all_parts: score.insert(0, p)
    
    return score