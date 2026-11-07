import csv
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location("cinematic", Path(__file__).parents[1] / "routers/cinematic.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class CinematicTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.mock = patch.object(module, "project_dir", return_value=Path(self.temp.name))
        self.mock.start()
        self.addCleanup(self.mock.stop)
        app = FastAPI()
        app.include_router(module.router, prefix="/api/workflow/cinematic")
        self.client = TestClient(app)
        self.base = "/api/workflow/cinematic"

    def create(self, **changes):
        project = {"title":"Sầu Vương", "preset":"vietnam_1990s", "characters":[{"id":"minh", "name":"Minh", "identity":"49 years old", "wardrobe":"cream jacket"}], "scenes":[{"id":"scene-1", "description":"Minh waits at the rainy station", "characters":["minh"]}]}
        project.update(changes)
        response = self.client.post(self.base+"/projects", json=project)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_roundtrip_and_edit(self):
        record = self.create()
        url = self.base+"/projects/"+record["id"]
        self.assertEqual(self.client.get(url).json(),record)
        record["project"]["title"]="Revised"
        self.assertEqual(self.client.put(url,json=record["project"]).status_code,200)
        self.assertEqual(self.client.get(self.base+"/projects").json()[0]["title"],"Revised")
        self.assertEqual(self.client.get(url+"/export/json").json()["title"],"Revised")

    def test_character_validation(self):
        for project in [{"characters":[{"id":"x","name":"A"},{"id":"x","name":"B"}]},{"scenes":[{"characters":["missing"]}]},{"scenes":[{"id":"same"},{"id":"same"}]}]:
            self.assertEqual(self.client.post(self.base+"/projects",json=project).status_code,422)

    def test_invalid_duration_and_id(self):
        self.assertEqual(self.client.post(self.base+"/projects",json={"scenes":[{"duration":0}]}).status_code,422)
        self.assertEqual(self.client.get(self.base+"/projects/not-a-uuid").status_code,422)
        self.assertEqual(self.client.get(self.base+"/projects/00000000-0000-0000-0000-000000000000").status_code,404)

    def test_prompt_continuity_and_override(self):
        record=self.create()
        url=self.base+"/projects/"+record["id"]
        text=self.client.get(url+"/export/prompts").text
        for expected in ["Vietnam in the 1990s", "49 years old", "cream jacket", "SC001", "draft"]:
            self.assertIn(expected,text)
        record["project"]["scenes"][0]["image_prompt"]="My exact override"
        self.client.put(url,json=record["project"])
        graph=self.client.post(url+"/graph",json={"stage":"image","scene_ids":["scene-1"]}).json()
        self.assertEqual(graph["workflow"]["nodes"][0]["config"]["prompt"],"My exact override")

    def test_csv_timing_and_formula_escape(self):
        record=self.create(scenes=[{"id":"one","title":"=1+1","duration":8},{"id":"two","title":"B","duration":6,"timing":"verified"}])
        response=self.client.get(self.base+"/projects/"+record["id"]+"/export/csv")
        rows=list(csv.reader(io.StringIO(response.text.lstrip("\ufeff"))))
        self.assertEqual(rows[1][1],"'=1+1")
        self.assertEqual(rows[2][2],"8.0")
        self.assertEqual(rows[2][4],"verified")

    def test_graph_stage_validation(self):
        record=self.create()
        url=self.base+"/projects/"+record["id"]+"/graph"
        self.assertEqual(self.client.post(url,json={"stage":"image_to_video","scene_ids":["scene-1"]}).status_code,422)
        self.assertEqual(self.client.post(url,json={"stage":"image","scene_ids":["missing"]}).status_code,422)
        self.assertEqual(self.client.post(url,json={"stage":"image","scene_ids":[]}).status_code,422)
        graph=self.client.post(url,json={"stage":"text_to_video","scene_ids":["scene-1"]}).json()["workflow"]
        self.assertEqual(graph["nodes"][0]["type"],"text_to_video")
        self.assertEqual(graph["nodes"][0]["config"]["duration"],8)

    def test_i2v_and_planned_duration(self):
        record=self.create(scenes=[{"id":"one","description":"A wave","duration":6,"media_id":"uploaded-id"}])
        url=self.base+"/projects/"+record["id"]
        self.assertEqual(self.client.post(url+"/graph",json={"stage":"image_to_video","scene_ids":["one"]}).status_code,422)
        record["project"]["scenes"][0]["duration"]=8
        self.client.put(url,json=record["project"])
        graph=self.client.post(url+"/graph",json={"stage":"image_to_video","scene_ids":["one"]}).json()["workflow"]
        self.assertEqual(graph["nodes"][0]["config"]["media_id"],"uploaded-id")

    def test_empty_prompt_rejected(self):
        record=self.create(scenes=[{"id":"one"}])
        self.assertEqual(self.client.post(self.base+"/projects/"+record["id"]+"/graph",json={"stage":"image","scene_ids":["one"]}).status_code,422)


if __name__ == "__main__":
    unittest.main()
