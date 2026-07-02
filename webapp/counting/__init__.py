"""
Counting Engine — Zone Counter + Line Counter + Object Tracker

สำหรับงานนับชิ้นงานในสายผลิต:
- Virtual Zone: กำหนด polygon zone, นับวัตถุที่เข้ามาใน zone
- Counting Line: นับวัตถุที่ข้ามเส้น
- Object Tracker: IoU-based + Hungarian algorithm สำหรับ tracking object
"""

import threading
import time
import json
import math
from dataclasses import dataclass, field, asdict
from typing import Optional
import numpy as np
from collections import defaultdict


@dataclass
class Zone:
    """Zone polygon — จุดยอด polygon ที่กำหนด zone"""
    id: str = ""
    name: str = ""
    points: list = field(default_factory=list)  # [[x1,y1], [x2,y2], ...] — normalized 0-1
    label: str = ""  # ชื่อ zone (e.g. "BIN_A", "CONVEYOR_BELT")


@dataclass
class CountingLine:
    """Counting Line — เส้นสำหรับนับของที่ข้าม"""
    id: str = ""
    name: str = ""
    x1: float = 0.0
    y1: float = 0.0
    x2: float = 0.0
    y2: float = 0.0
    direction: str = "both"  # both | left_to_right | right_to_left | top_to_bottom | bottom_to_top


@dataclass 
class Detection:
    """Detection result จากโมเดล"""
    class_id: int
    class_name: str
    confidence: float
    bbox: list  # [x1, y1, x2, y2] — normalized 0-1
    
    @property
    def cx(self):
        return (self.bbox[0] + self.bbox[2]) / 2
    
    @property
    def cy(self):
        return (self.bbox[1] + self.bbox[3]) / 2
    
    @property
    def width(self):
        return self.bbox[2] - self.bbox[0]
    
    @property
    def height(self):
        return self.bbox[3] - self.bbox[1]


@dataclass
class TrackedObject:
    """Object ที่ถูก track — มี ID คงที่"""
    id: int
    class_id: int
    class_name: str
    bbox: list  # [x1, y1, x2, y2]
    cx: float
    cy: float
    age: int = 0
    hit_streak: int = 1
    last_seen: float = 0.0
    
    # สำหรับ counting line
    prev_cx: float = 0.0
    prev_cy: float = 0.0
    
    # zone tracking
    zones_in: set = field(default_factory=set)  # zones that object is currently in
    counted_zones: set = field(default_factory=set)  # zones already counted for this object


def _iou(box1, box2):
    """Calculate IoU between two boxes [x1, y1, x2, y2]"""
    xi1 = max(box1[0], box2[0])
    yi1 = max(box1[1], box2[1])
    xi2 = min(box1[2], box2[2])
    yi2 = min(box1[3], box2[3])
    inter = max(0, xi2 - xi1) * max(0, yi2 - yi1)
    if inter == 0:
        return 0.0
    box1_area = (box1[2] - box1[0]) * (box1[3] - box1[1])
    box2_area = (box2[2] - box2[0]) * (box2[3] - box2[1])
    union = box1_area + box2_area - inter
    return inter / union if union > 0 else 0.0


def _point_in_polygon(px, py, polygon):
    """Ray casting algorithm — check ถ้าจุดอยู่ใน polygon"""
    # polygon = [[x1,y1], [x2,y2], ...] normalized 0-1
    # px, py normalized 0-1
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _line_cross_direction(x1, y1, x2, y2, px1, py1, px2, py2):
    """
    Check ถ้าวัตถุข้ามเส้น counting line หรือไม่
    ใช้ cross product (2D) เพื่อเช็คว่าวัตถุอยู่ฝั่งไหนของเส้น
    """
    # Line vector
    lx = x2 - x1
    ly = y2 - y1
    
    # Cross product for old position and new position
    old_cross = lx * (py1 - y1) - ly * (px1 - x1)
    new_cross = lx * (py2 - y1) - ly * (px2 - x1)
    
    # ตรวจสอบว่าอยู่คนละฝั่ง
    if old_cross * new_cross < 0:
        # หาจุดตัด
        denom = lx * (py2 - py1) - ly * (px2 - px1)
        if abs(denom) < 1e-10:
            return None
        t = lx * (y1 - py1) - ly * (x1 - px1)
        t /= denom
        # Check ถ้าอยู่ใน segment
        if 0 <= t <= 1:
            return "left_to_right" if new_cross > 0 else "right_to_left"
    return None


class CountingEngine:
    """ตัวนับ — Zone + Line + Tracker"""
    
    def __init__(self, camera_id: int):
        self.camera_id = camera_id
        self._lock = threading.Lock()
        
        # Configuration
        self.zones: dict[str, Zone] = {}
        self.lines: dict[str, CountingLine] = {}
        self.track_iou_threshold = 0.3
        self.max_track_age = 15  # frames ก่อนลืม object
        self.min_hit_streak = 2  # objects ต้องโดน track กี่ frame ถึงนับ
        
        # Tracking state
        self._next_track_id = 1
        self._active_tracks: dict[int, TrackedObject] = {}
        
        # Count results
        self._zone_counts: dict[str, int] = defaultdict(int)  # zone_id -> count
        self._line_counts: dict[str, int] = defaultdict(int)  # line_id -> count
        self._class_counts: dict[str, int] = defaultdict(int)  # class_name -> total count
        
        self._frame_number = 0
        self._start_time = time.time()
        
        # History — keep last 24h of counts
        self._count_history: list = []
    
    def add_zone(self, zone: Zone):
        with self._lock:
            self.zones[zone.id] = zone
    
    def remove_zone(self, zone_id: str):
        with self._lock:
            self.zones.pop(zone_id, None)
    
    def add_line(self, line: CountingLine):
        with self._lock:
            self.lines[line.id] = line
    
    def remove_line(self, line_id: str):
        with self._lock:
            self.lines.pop(line_id, None)
    
    def set_tracking_params(self, iou_thresh=None, max_age=None, min_hit=None):
        with self._lock:
            if iou_thresh is not None:
                self.track_iou_threshold = iou_thresh
            if max_age is not None:
                self.max_track_age = max_age
            if min_hit is not None:
                self.min_hit_streak = min_hit
    
    def _assign_track_id(self) -> int:
        tid = self._next_track_id
        self._next_track_id += 1
        return tid
    
    def update(self, detections: list[dict]) -> dict:
        """
        update tracking + counting จาก detection results
        
        Input: detections = [
            {"class_id": 0, "class_name": "bolt", "confidence": 0.95, 
             "bbox": [0.1, 0.2, 0.3, 0.4]},
            ...
        ]
        bbox เป็น normalized 0-1
        
        Return: {
            "tracked_objects": [...],
            "zone_counts": {...},
            "line_counts": {...},
            "frame_counts": {...}
        }
        """
        now = time.time()
        
        # Parse detections
        dets = []
        for d in detections:
            bbox = d.get("bbox", [0, 0, 0, 0])
            dets.append(Detection(
                class_id=d.get("class_id", 0),
                class_name=d.get("class_name", d.get("class", "unknown")),
                confidence=d.get("confidence", 1.0),
                bbox=[bbox[0], bbox[1], bbox[2], bbox[3]],
            ))
        
        with self._lock:
            self._frame_number += 1
            
            # Step 1: IoU matching with existing tracks
            matched_dets = set()
            updated_tracks = {}
            
            used_tracks = set()
            used_dets = set()

            if self._active_tracks:
                # Build cost matrix (IoU)
                track_ids = list(self._active_tracks.keys())
                costs = np.zeros((len(track_ids), len(dets)))
                for ti, tid in enumerate(track_ids):
                    track = self._active_tracks[tid]
                    for di, det in enumerate(dets):
                        costs[ti, di] = _iou(track.bbox, det.bbox)

                # Greedy matching (simpler than Hungarian for small # of objects)
                for _ in range(min(len(track_ids), len(dets))):
                    max_iou = self.track_iou_threshold
                    best_t = -1
                    best_d = -1
                    for ti in range(len(track_ids)):
                        if ti in used_tracks:
                            continue
                        for di in range(len(dets)):
                            if di in used_dets:
                                continue
                            if costs[ti, di] > max_iou:
                                max_iou = costs[ti, di]
                                best_t = ti
                                best_d = di
                    if best_t >= 0:
                        used_tracks.add(best_t)
                        used_dets.add(best_d)
                        tid = track_ids[best_t]
                        old = self._active_tracks[tid]
                        det = dets[best_d]
                        
                        prev_cx, prev_cy = old.cx, old.cy
                        
                        updated_tracks[tid] = TrackedObject(
                            id=tid,
                            class_id=det.class_id,
                            class_name=det.class_name,
                            bbox=det.bbox,
                            cx=det.cx,
                            cy=det.cy,
                            age=old.age + 1,
                            hit_streak=old.hit_streak + 1,
                            last_seen=now,
                            prev_cx=prev_cx,
                            prev_cy=prev_cy,
                            zones_in=old.zones_in,
                            counted_zones=old.counted_zones,
                        )
            
            # Step 2: Create new tracks for unmatched detections
            matched_det_indices = used_dets
            for di, det in enumerate(dets):
                if di not in matched_det_indices:
                    tid = self._assign_track_id()
                    updated_tracks[tid] = TrackedObject(
                        id=tid,
                        class_id=det.class_id,
                        class_name=det.class_name,
                        bbox=det.bbox,
                        cx=det.cx,
                        cy=det.cy,
                        age=1,
                        hit_streak=1,
                        last_seen=now,
                        prev_cx=det.cx,
                        prev_cy=det.cy,
                    )
            
            # Step 3: Remove stale tracks
            for tid, track in self._active_tracks.items():
                if tid not in updated_tracks and now - track.last_seen < self.max_track_age * (1.0 / 15.0):
                    # still keep but age it
                    updated_tracks[tid] = TrackedObject(
                        id=tid,
                        class_id=track.class_id,
                        class_name=track.class_name,
                        bbox=track.bbox,
                        cx=track.cx,
                        cy=track.cy,
                        age=track.age + 1,
                        hit_streak=0,
                        last_seen=now,
                        prev_cx=track.cx,
                        prev_cy=track.cy,
                        zones_in=set(),
                        counted_zones=track.counted_zones,
                    )
            
            self._active_tracks = updated_tracks
            
            # Step 4: Zone counting
            for track in self._active_tracks.values():
                if track.hit_streak < self.min_hit_streak:
                    continue
                
                cx, cy = track.cx, track.cy
                
                for zid, zone in self.zones.items():
                    # Normalize? Points are already normalized 0-1
                    if _point_in_polygon(cx, cy, zone.points):
                        # New entry into zone
                        if zid not in track.zones_in:
                            self._zone_counts[zid] += 1
                            track.counted_zones.add(zid)
                        track.zones_in.add(zid)
                    else:
                        track.zones_in.discard(zid)
            
            # Step 5: Line counting
            for track in self._active_tracks.values():
                if track.hit_streak < self.min_hit_streak:
                    continue
                
                for lid, line in self.lines.items():
                    direction = _line_cross_direction(
                        line.x1, line.y1, line.x2, line.y2,
                        track.prev_cx, track.prev_cy, track.cx, track.cy,
                    )
                    if direction:
                        if line.direction == "both" or direction == line.direction:
                            self._line_counts[lid] += 1
            
            # Step 6: Class counts
            frame_class_counts = defaultdict(int)
            for det in dets:
                frame_class_counts[det.class_name] += 1
            for cls_name, cnt in frame_class_counts.items():
                self._class_counts[cls_name] += cnt
            
            # Step 7: Build output
            tracked_objects = []
            for track in self._active_tracks.values():
                tracked_objects.append({
                    "id": track.id,
                    "class_id": track.class_id,
                    "class_name": track.class_name,
                    "bbox": track.bbox,
                    "cx": track.cx,
                    "cy": track.cy,
                    "age": track.age,
                    "hit_streak": track.hit_streak,
                    "zones_in": list(track.zones_in),
                })
            
            result = {
                "tracked_objects": tracked_objects,
                "zone_counts": dict(self._zone_counts),
                "line_counts": dict(self._line_counts),
                "frame_counts": dict(frame_class_counts),
                "total_class_counts": dict(self._class_counts),
                "frame": self._frame_number,
            }
            
            # Record history (every 100 frames)
            if self._frame_number % 100 == 0:
                self._count_history.append({
                    "ts": now,
                    "frame": self._frame_number,
                    "zone_counts": dict(self._zone_counts),
                    "line_counts": dict(self._line_counts),
                })
                # Keep 24h
                cutoff = now - 86400
                self._count_history = [h for h in self._count_history if h["ts"] > cutoff]
            
            return result
    
    def get_stats(self) -> dict:
        """Get current statistics"""
        with self._lock:
            return {
                "camera_id": self.camera_id,
                "uptime": time.time() - self._start_time,
                "frames": self._frame_number,
                "active_tracks": len(self._active_tracks),
                "zones": len(self.zones),
                "lines": len(self.lines),
                "zone_counts": dict(self._zone_counts),
                "line_counts": dict(self._line_counts),
                "total_class_counts": dict(self._class_counts),
                "history": self._count_history[-50:],  # last 50 snapshots
            }
    
    def reset_counts(self):
        """Reset all counters (start of shift, etc.)"""
        with self._lock:
            self._zone_counts.clear()
            self._line_counts.clear()
            self._class_counts.clear()
            self._count_history.clear()
            self._frame_number = 0
            self._start_time = time.time()