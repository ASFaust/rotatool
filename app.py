# app.py
from flask import Flask, render_template
from flask_migrate import Migrate

from models import db
from routes.people import people_bp
from routes.shifts import shifts_bp
from routes.rota import rota_bp
from routes.main import main_bp  # Import the main blueprint
from routes.skills import skills_bp

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///rota.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)
migrate = Migrate(app, db)

with app.app_context():
    db.create_all()

app.register_blueprint(people_bp)
app.register_blueprint(shifts_bp)
app.register_blueprint(rota_bp)
app.register_blueprint(main_bp)  # Register the main blueprint
app.register_blueprint(skills_bp)

if __name__ == '__main__':
    app.run(debug=True)